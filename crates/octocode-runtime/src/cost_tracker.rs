use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use octocode_core::TokenInfo;

/// Cost per million tokens for a model (in USD).
#[derive(Debug, Clone)]
pub struct ModelPricing {
    pub input_per_million: f64,
    pub output_per_million: f64,
}

/// A single usage record.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct UsageRecord {
    pub session_id: String,
    pub provider_id: String,
    pub model: String,
    pub tokens: TokenInfo,
    pub at_ms: u128,
}

/// Tracks token usage and estimated costs across sessions and providers.
#[derive(Debug, Clone, Default)]
pub struct CostTracker {
    records: Arc<Mutex<Vec<UsageRecord>>>,
    pricing: Arc<Mutex<HashMap<String, ModelPricing>>>,
}

impl CostTracker {
    pub fn new() -> Self {
        let tracker = Self::default();
        // Seed common model pricing.
        let mut pricing = tracker.pricing.lock().unwrap();
        pricing.insert(String::from("gpt-4o"), ModelPricing { input_per_million: 2.50, output_per_million: 10.00 });
        pricing.insert(String::from("gpt-4o-mini"), ModelPricing { input_per_million: 0.15, output_per_million: 0.60 });
        pricing.insert(String::from("claude-sonnet-4-20250514"), ModelPricing { input_per_million: 3.00, output_per_million: 15.00 });
        pricing.insert(String::from("claude-opus-4-20250514"), ModelPricing { input_per_million: 15.00, output_per_million: 75.00 });
        pricing.insert(String::from("claude-3-haiku"), ModelPricing { input_per_million: 0.25, output_per_million: 1.25 });
        pricing.insert(String::from("gemma-4-31b-it-q8-prod"), ModelPricing { input_per_million: 0.00, output_per_million: 0.00 });
        drop(pricing);
        tracker
    }

    /// Record a usage event.
    pub fn record(
        &self,
        session_id: &str,
        provider_id: &str,
        model: &str,
        tokens: TokenInfo,
    ) {
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        self.records.lock().unwrap().push(UsageRecord {
            session_id: String::from(session_id),
            provider_id: String::from(provider_id),
            model: String::from(model),
            tokens,
            at_ms,
        });
    }

    /// Get total tokens for a session.
    pub fn session_tokens(&self, session_id: &str) -> TokenInfo {
        let guard = self.records.lock().unwrap();
        let mut input = 0u32;
        let mut output = 0u32;
        for r in guard.iter().filter(|r| r.session_id == session_id) {
            input = input.saturating_add(r.tokens.input_tokens);
            output = output.saturating_add(r.tokens.output_tokens);
        }
        TokenInfo::new(input, output)
    }

    /// Get total tokens across all sessions.
    pub fn total_tokens(&self) -> TokenInfo {
        let guard = self.records.lock().unwrap();
        let mut input = 0u32;
        let mut output = 0u32;
        for r in guard.iter() {
            input = input.saturating_add(r.tokens.input_tokens);
            output = output.saturating_add(r.tokens.output_tokens);
        }
        TokenInfo::new(input, output)
    }

    /// Estimate cost for a session in USD.
    pub fn session_cost_usd(&self, session_id: &str) -> f64 {
        let guard = self.records.lock().unwrap();
        let pricing = self.pricing.lock().unwrap();
        let mut total = 0.0f64;
        for r in guard.iter().filter(|r| r.session_id == session_id) {
            if let Some(p) = pricing.get(&r.model) {
                total += (r.tokens.input_tokens as f64 / 1_000_000.0) * p.input_per_million;
                total += (r.tokens.output_tokens as f64 / 1_000_000.0) * p.output_per_million;
            }
        }
        total
    }

    /// Estimate total cost in USD.
    pub fn total_cost_usd(&self) -> f64 {
        let guard = self.records.lock().unwrap();
        let pricing = self.pricing.lock().unwrap();
        let mut total = 0.0f64;
        for r in guard.iter() {
            if let Some(p) = pricing.get(&r.model) {
                total += (r.tokens.input_tokens as f64 / 1_000_000.0) * p.input_per_million;
                total += (r.tokens.output_tokens as f64 / 1_000_000.0) * p.output_per_million;
            }
        }
        total
    }

    /// Set custom pricing for a model.
    pub fn set_pricing(&self, model: &str, pricing: ModelPricing) {
        self.pricing.lock().unwrap().insert(String::from(model), pricing);
    }

    /// Format a human-readable cost summary.
    pub fn summary(&self) -> String {
        let tokens = self.total_tokens();
        let cost = self.total_cost_usd();
        format!(
            "Total: {} input + {} output tokens ≈ ${:.4} USD",
            tokens.input_tokens, tokens.output_tokens, cost
        )
    }

    /// Number of usage records.
    pub fn record_count(&self) -> usize {
        self.records.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_and_query() {
        let tracker = CostTracker::new();
        tracker.record("s1", "openai", "gpt-4o", TokenInfo::new(1000, 500));
        tracker.record("s1", "openai", "gpt-4o", TokenInfo::new(2000, 1000));
        let tokens = tracker.session_tokens("s1");
        assert_eq!(tokens.input_tokens, 3000);
        assert_eq!(tokens.output_tokens, 1500);
    }

    #[test]
    fn cost_estimation() {
        let tracker = CostTracker::new();
        // 1M input tokens at $2.50 + 1M output tokens at $10.00 = $12.50
        tracker.record("s1", "openai", "gpt-4o", TokenInfo::new(1_000_000, 1_000_000));
        let cost = tracker.session_cost_usd("s1");
        assert!((cost - 12.50).abs() < 0.01);
    }

    #[test]
    fn free_local_model() {
        let tracker = CostTracker::new();
        tracker.record("s1", "local", "gemma-4-31b-it-q8-prod", TokenInfo::new(100000, 50000));
        assert!((tracker.total_cost_usd() - 0.0).abs() < 0.001);
    }

    #[test]
    fn summary_format() {
        let tracker = CostTracker::new();
        tracker.record("s1", "p", "gpt-4o-mini", TokenInfo::new(100, 200));
        let s = tracker.summary();
        assert!(s.contains("100 input"));
        assert!(s.contains("200 output"));
    }
}
