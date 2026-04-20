//! Performance benchmarks module — measures latency percentiles (P50, P95, P99)
//! for key runtime operations to establish baseline performance metrics.

use std::time::{Duration, Instant};

/// Serialise a `PercentileReport` to JSON for CI pipeline consumption.
impl PercentileReport {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"label\":\"{}\",\"sample_count\":{},\"p50_ms\":{:.3},\"p95_ms\":{:.3},\"p99_ms\":{:.3},\"min_ms\":{:.3},\"max_ms\":{:.3},\"mean_ms\":{:.3}}}",
            self.label, self.sample_count, self.p50_ms, self.p95_ms, self.p99_ms, self.min_ms, self.max_ms, self.mean_ms
        )
    }

    /// Parse a JSON-encoded report (minimal parser for CI round-trip).
    pub fn from_json(json: &str) -> Option<Self> {
        let get = |key: &str| -> Option<&str> {
            let needle = format!("\"{}\":", key);
            let start = json.find(&needle)? + needle.len();
            let rest = &json[start..];
            let end = rest.find(|c: char| c == ',' || c == '}')?;
            Some(rest[..end].trim().trim_matches('"'))
        };
        Some(Self {
            label: get("label")?.to_string(),
            sample_count: get("sample_count")?.parse().ok()?,
            p50_ms: get("p50_ms")?.parse().ok()?,
            p95_ms: get("p95_ms")?.parse().ok()?,
            p99_ms: get("p99_ms")?.parse().ok()?,
            min_ms: get("min_ms")?.parse().ok()?,
            max_ms: get("max_ms")?.parse().ok()?,
            mean_ms: get("mean_ms")?.parse().ok()?,
        })
    }
}

/// Result of comparing a benchmark report against a baseline.
#[derive(Debug, Clone)]
pub struct RegressionCheckResult {
    pub label: String,
    pub passed: bool,
    pub p99_baseline_ms: f64,
    pub p99_current_ms: f64,
    /// Percentage change relative to baseline (positive = slower).
    pub p99_delta_pct: f64,
    pub detail: String,
}

/// Compare a current report against a baseline, flagging regressions.
///
/// `threshold_pct` is the maximum allowed increase in P99 latency (e.g. 10.0
/// means "fail if P99 increased by more than 10%").
pub fn check_regression(
    baseline: &PercentileReport,
    current: &PercentileReport,
    threshold_pct: f64,
) -> RegressionCheckResult {
    let delta = if baseline.p99_ms > 0.0 {
        ((current.p99_ms - baseline.p99_ms) / baseline.p99_ms) * 100.0
    } else {
        0.0
    };
    let passed = delta <= threshold_pct;
    let detail = if passed {
        format!(
            "{}: P99 {:.2}ms → {:.2}ms ({:+.1}%) — OK",
            current.label, baseline.p99_ms, current.p99_ms, delta
        )
    } else {
        format!(
            "{}: P99 {:.2}ms → {:.2}ms ({:+.1}%) — REGRESSION (threshold {:.1}%)",
            current.label, baseline.p99_ms, current.p99_ms, delta, threshold_pct
        )
    };
    RegressionCheckResult {
        label: current.label.clone(),
        passed,
        p99_baseline_ms: baseline.p99_ms,
        p99_current_ms: current.p99_ms,
        p99_delta_pct: delta,
        detail,
    }
}

/// Gate: check all reports against baselines. Returns `Err` listing regressions
/// if any benchmark exceeds the threshold.
pub fn gate_benchmarks(
    baselines: &[PercentileReport],
    current: &[PercentileReport],
    threshold_pct: f64,
) -> Result<Vec<RegressionCheckResult>, Vec<RegressionCheckResult>> {
    let mut results = Vec::new();
    for cur in current {
        if let Some(base) = baselines.iter().find(|b| b.label == cur.label) {
            results.push(check_regression(base, cur, threshold_pct));
        }
    }
    let failures: Vec<_> = results.iter().filter(|r| !r.passed).cloned().collect();
    if failures.is_empty() {
        Ok(results)
    } else {
        Err(failures)
    }
}

/// A collected latency sample.
#[derive(Debug, Clone, Copy)]
pub struct LatencySample {
    pub duration: Duration,
}

/// Percentile results from a benchmark run.
#[derive(Debug, Clone)]
pub struct PercentileReport {
    pub label: String,
    pub sample_count: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub mean_ms: f64,
}

impl std::fmt::Display for PercentileReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{}] n={} | P50={:.2}ms P95={:.2}ms P99={:.2}ms | min={:.2}ms max={:.2}ms mean={:.2}ms",
            self.label, self.sample_count, self.p50_ms, self.p95_ms, self.p99_ms,
            self.min_ms, self.max_ms, self.mean_ms
        )
    }
}

/// Benchmark harness that collects latency samples and computes percentiles.
pub struct Benchmark {
    label: String,
    samples: Vec<Duration>,
}

impl Benchmark {
    pub fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            samples: Vec::new(),
        }
    }

    /// Record a single sample.
    pub fn record(&mut self, duration: Duration) {
        self.samples.push(duration);
    }

    /// Time a closure and record the duration.
    pub fn measure<F, R>(&mut self, f: F) -> R
    where
        F: FnOnce() -> R,
    {
        let start = Instant::now();
        let result = f();
        self.samples.push(start.elapsed());
        result
    }

    /// Run a closure N times and collect all samples.
    pub fn run_iterations<F>(&mut self, iterations: usize, mut f: F)
    where
        F: FnMut(usize),
    {
        for i in 0..iterations {
            let start = Instant::now();
            f(i);
            self.samples.push(start.elapsed());
        }
    }

    /// Compute percentile report from collected samples.
    pub fn report(&self) -> PercentileReport {
        if self.samples.is_empty() {
            return PercentileReport {
                label: self.label.clone(),
                sample_count: 0,
                p50_ms: 0.0,
                p95_ms: 0.0,
                p99_ms: 0.0,
                min_ms: 0.0,
                max_ms: 0.0,
                mean_ms: 0.0,
            };
        }

        let mut sorted: Vec<f64> = self
            .samples
            .iter()
            .map(|d| d.as_secs_f64() * 1000.0)
            .collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let n = sorted.len();
        let sum: f64 = sorted.iter().sum();

        PercentileReport {
            label: self.label.clone(),
            sample_count: n,
            p50_ms: percentile(&sorted, 50.0),
            p95_ms: percentile(&sorted, 95.0),
            p99_ms: percentile(&sorted, 99.0),
            min_ms: sorted[0],
            max_ms: sorted[n - 1],
            mean_ms: sum / n as f64,
        }
    }

    /// Reset all collected samples.
    pub fn reset(&mut self) {
        self.samples.clear();
    }

    /// Number of samples collected.
    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }
}

/// A suite of multiple benchmarks run together.
pub struct BenchmarkSuite {
    pub name: String,
    benchmarks: Vec<Benchmark>,
}

impl BenchmarkSuite {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            benchmarks: Vec::new(),
        }
    }

    pub fn add(&mut self, benchmark: Benchmark) {
        self.benchmarks.push(benchmark);
    }

    pub fn reports(&self) -> Vec<PercentileReport> {
        self.benchmarks.iter().map(|b| b.report()).collect()
    }

    pub fn summary(&self) -> String {
        let mut lines = vec![format!("=== Benchmark Suite: {} ===", self.name)];
        for report in self.reports() {
            lines.push(format!("  {}", report));
        }
        lines.join("\n")
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

fn percentile(sorted: &[f64], pct: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = (pct / 100.0 * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

// ─── Built-in benchmark scenarios ──────────────────────────────────────────────

/// Benchmark: session store read/write latency.
pub fn bench_session_store_ops(iterations: usize) -> Benchmark {
    use std::collections::HashMap;

    let mut bench = Benchmark::new("session_store_ops");

    // Simulate session save/load with in-memory HashMap
    let mut store: HashMap<String, String> = HashMap::new();
    bench.run_iterations(iterations, |i| {
        let key = format!("session_{i}");
        let value = format!("{{\"id\":\"{key}\",\"title\":\"Test\",\"tokens\":0}}");
        store.insert(key.clone(), value);
        let _ = store.get(&key);
    });

    bench
}

/// Benchmark: message serialization throughput.
pub fn bench_message_serialization(iterations: usize) -> Benchmark {
    let mut bench = Benchmark::new("message_serialization");

    bench.run_iterations(iterations, |i| {
        let msg = format!(
            "{{\"role\":\"user\",\"content\":\"Message number {} with some content to serialize\"}}",
            i
        );
        let _parsed: serde_json::Value = serde_json::from_str(&msg).unwrap_or_default();
        let _back = serde_json::to_string(&_parsed).unwrap_or_default();
    });

    bench
}

/// Benchmark: rate limiter throughput.
pub fn bench_rate_limiter(iterations: usize) -> Benchmark {
    use std::collections::HashMap;

    let mut bench = Benchmark::new("rate_limiter_check");
    let mut buckets: HashMap<String, u32> = HashMap::new();

    bench.run_iterations(iterations, |i| {
        let ip = format!("192.168.1.{}", i % 256);
        let count = buckets.entry(ip).or_insert(0);
        *count += 1;
        let _allowed = *count <= 30;
    });

    bench
}

/// Benchmark: plugin dispatch overhead.
pub fn bench_plugin_dispatch(iterations: usize) -> Benchmark {
    let mut bench = Benchmark::new("plugin_dispatch");

    // Simulate dispatching hooks through a plugin vector
    let plugins: Vec<Box<dyn Fn(&str) -> Option<String>>> = vec![
        Box::new(|hook| {
            if hook == "before_prompt" {
                Some("audited".into())
            } else {
                None
            }
        }),
        Box::new(|_| None),
    ];

    bench.run_iterations(iterations, |_| {
        for plugin in &plugins {
            let _ = plugin("before_prompt");
        }
    });

    bench
}

/// Run the full built-in benchmark suite.
pub fn run_standard_suite(iterations: usize) -> BenchmarkSuite {
    let mut suite = BenchmarkSuite::new("Octocode Standard Benchmarks");
    suite.add(bench_session_store_ops(iterations));
    suite.add(bench_message_serialization(iterations));
    suite.add(bench_rate_limiter(iterations));
    suite.add(bench_plugin_dispatch(iterations));
    suite
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn benchmark_basic_usage() {
        let mut bench = Benchmark::new("test_op");
        bench.run_iterations(100, |_| {
            let _ = (0..100).sum::<u64>();
        });

        let report = bench.report();
        assert_eq!(report.label, "test_op");
        assert_eq!(report.sample_count, 100);
        assert!(report.p50_ms >= 0.0);
        assert!(report.p95_ms >= report.p50_ms);
        assert!(report.p99_ms >= report.p95_ms);
        assert!(report.min_ms <= report.max_ms);
    }

    #[test]
    fn benchmark_measure_closure() {
        let mut bench = Benchmark::new("closure");
        let result = bench.measure(|| 42);
        assert_eq!(result, 42);
        assert_eq!(bench.sample_count(), 1);
    }

    #[test]
    fn benchmark_empty_report() {
        let bench = Benchmark::new("empty");
        let report = bench.report();
        assert_eq!(report.sample_count, 0);
        assert_eq!(report.p50_ms, 0.0);
    }

    #[test]
    fn percentile_calculation() {
        let data = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        // With 10 elements (indices 0..9):
        // P50 = index round(0.50 * 9) = round(4.5) = 5 → data[5] = 6.0
        // P99 = index round(0.99 * 9) = round(8.91) = 9 → data[9] = 10.0
        // P0  = index round(0.00 * 9) = round(0) = 0 → data[0] = 1.0
        let p50 = percentile(&data, 50.0);
        assert!(p50 >= 5.0 && p50 <= 6.0, "P50 was {}", p50);
        assert_eq!(percentile(&data, 99.0), 10.0); // near max
        assert_eq!(percentile(&data, 0.0), 1.0); // min
    }

    #[test]
    fn benchmark_suite_summary() {
        let mut suite = BenchmarkSuite::new("Test Suite");
        let mut b1 = Benchmark::new("fast_op");
        b1.record(Duration::from_micros(100));
        b1.record(Duration::from_micros(150));
        suite.add(b1);

        let summary = suite.summary();
        assert!(summary.contains("Test Suite"));
        assert!(summary.contains("fast_op"));
        assert!(summary.contains("P99"));
    }

    #[test]
    fn standard_suite_runs() {
        let suite = run_standard_suite(50);
        let reports = suite.reports();
        assert_eq!(reports.len(), 4);
        for report in &reports {
            assert_eq!(report.sample_count, 50);
            assert!(report.p99_ms < 1000.0); // should all be <1s
        }
    }

    #[test]
    fn benchmark_reset() {
        let mut bench = Benchmark::new("resettable");
        bench.record(Duration::from_millis(1));
        assert_eq!(bench.sample_count(), 1);
        bench.reset();
        assert_eq!(bench.sample_count(), 0);
    }

    #[test]
    fn report_display() {
        let mut bench = Benchmark::new("display_test");
        bench.record(Duration::from_millis(5));
        bench.record(Duration::from_millis(10));
        bench.record(Duration::from_millis(15));

        let report = bench.report();
        let display = format!("{}", report);
        assert!(display.contains("display_test"));
        assert!(display.contains("n=3"));
        assert!(display.contains("P50"));
    }

    #[test]
    fn report_json_roundtrip() {
        let report = PercentileReport {
            label: "test_op".into(),
            sample_count: 100,
            p50_ms: 1.5,
            p95_ms: 3.2,
            p99_ms: 5.1,
            min_ms: 0.8,
            max_ms: 6.0,
            mean_ms: 2.0,
        };
        let json = report.to_json();
        let parsed = PercentileReport::from_json(&json).expect("should parse");
        assert_eq!(parsed.label, "test_op");
        assert_eq!(parsed.sample_count, 100);
        assert!((parsed.p99_ms - 5.1).abs() < 0.01);
    }

    #[test]
    fn regression_pass() {
        let baseline = PercentileReport {
            label: "op".into(), sample_count: 50,
            p50_ms: 1.0, p95_ms: 2.0, p99_ms: 3.0,
            min_ms: 0.5, max_ms: 4.0, mean_ms: 1.5,
        };
        let current = PercentileReport {
            label: "op".into(), sample_count: 50,
            p50_ms: 1.1, p95_ms: 2.1, p99_ms: 3.2, // +6.7%
            min_ms: 0.5, max_ms: 4.0, mean_ms: 1.6,
        };
        let result = check_regression(&baseline, &current, 10.0);
        assert!(result.passed);
        assert!(result.detail.contains("OK"));
    }

    #[test]
    fn regression_fail() {
        let baseline = PercentileReport {
            label: "op".into(), sample_count: 50,
            p50_ms: 1.0, p95_ms: 2.0, p99_ms: 3.0,
            min_ms: 0.5, max_ms: 4.0, mean_ms: 1.5,
        };
        let current = PercentileReport {
            label: "op".into(), sample_count: 50,
            p50_ms: 2.0, p95_ms: 4.0, p99_ms: 6.0, // +100%
            min_ms: 1.0, max_ms: 7.0, mean_ms: 3.0,
        };
        let result = check_regression(&baseline, &current, 10.0);
        assert!(!result.passed);
        assert!(result.detail.contains("REGRESSION"));
    }

    #[test]
    fn gate_benchmarks_mixed() {
        let baselines = vec![
            PercentileReport {
                label: "fast".into(), sample_count: 50,
                p50_ms: 1.0, p95_ms: 2.0, p99_ms: 3.0,
                min_ms: 0.5, max_ms: 4.0, mean_ms: 1.5,
            },
            PercentileReport {
                label: "slow".into(), sample_count: 50,
                p50_ms: 10.0, p95_ms: 20.0, p99_ms: 30.0,
                min_ms: 5.0, max_ms: 40.0, mean_ms: 15.0,
            },
        ];
        let current = vec![
            PercentileReport {
                label: "fast".into(), sample_count: 50,
                p50_ms: 1.0, p95_ms: 2.0, p99_ms: 3.1, // +3.3% OK
                min_ms: 0.5, max_ms: 4.0, mean_ms: 1.5,
            },
            PercentileReport {
                label: "slow".into(), sample_count: 50,
                p50_ms: 20.0, p95_ms: 40.0, p99_ms: 60.0, // +100% FAIL
                min_ms: 10.0, max_ms: 80.0, mean_ms: 30.0,
            },
        ];
        let result = gate_benchmarks(&baselines, &current, 10.0);
        assert!(result.is_err());
        let failures = result.unwrap_err();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].label, "slow");
    }
}
