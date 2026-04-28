use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Role a sub-agent plays in coordinator mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentRole {
    Architect,
    Executor,
    Reviewer,
    Custom(String),
}

impl AgentRole {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Architect => "architect",
            Self::Executor => "executor",
            Self::Reviewer => "reviewer",
            Self::Custom(name) => name.as_str(),
        }
    }
}

/// State of a sub-agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentState {
    Idle,
    Running,
    Completed,
    Failed(String),
}

/// A sub-agent descriptor within a coordinator team.
#[derive(Debug, Clone)]
pub struct SubAgent {
    pub id: String,
    pub role: AgentRole,
    pub session_id: String,
    pub state: AgentState,
    pub system_prompt: Option<String>,
    pub created_at_ms: u128,
    pub finished_at_ms: Option<u128>,
    pub output: Option<String>,
}

/// A team of coordinated agents working on a shared goal.
#[derive(Debug, Clone)]
pub struct AgentTeam {
    pub id: String,
    pub goal: String,
    pub agents: Vec<SubAgent>,
    pub created_at_ms: u128,
}

/// Inter-agent message for communication.
#[derive(Debug, Clone)]
pub struct AgentMessage {
    pub from_agent_id: String,
    pub to_agent_id: String,
    pub content: String,
    pub at_ms: u128,
}

static AGENT_COUNTER: AtomicU64 = AtomicU64::new(1);
static TEAM_COUNTER: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Coordinator engine that manages multi-agent teams.
#[derive(Debug, Clone, Default)]
pub struct CoordinatorEngine {
    teams: Arc<Mutex<Vec<AgentTeam>>>,
    messages: Arc<Mutex<Vec<AgentMessage>>>,
}

impl CoordinatorEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a new team with a goal and set of agent roles.
    pub fn create_team(&self, goal: &str, roles: &[AgentRole]) -> AgentTeam {
        let team_n = TEAM_COUNTER.fetch_add(1, Ordering::SeqCst);
        let team_id = format!("team-{team_n}");
        let now = now_ms();

        let agents: Vec<SubAgent> = roles
            .iter()
            .map(|role| {
                let n = AGENT_COUNTER.fetch_add(1, Ordering::SeqCst);
                let agent_id = format!("agent-{n}");
                let session_id = format!("{team_id}-{agent_id}");
                SubAgent {
                    id: agent_id,
                    role: role.clone(),
                    session_id,
                    state: AgentState::Idle,
                    system_prompt: Some(default_system_prompt(role)),
                    created_at_ms: now,
                    finished_at_ms: None,
                    output: None,
                }
            })
            .collect();

        let team = AgentTeam {
            id: team_id,
            goal: String::from(goal),
            agents,
            created_at_ms: now,
        };

        self.teams.lock().unwrap().push(team.clone());
        team
    }

    /// Delete a team by id.
    pub fn delete_team(&self, team_id: &str) -> bool {
        let mut guard = self.teams.lock().unwrap();
        let len_before = guard.len();
        guard.retain(|t| t.id != team_id);
        guard.len() < len_before
    }

    /// List all teams.
    pub fn list_teams(&self) -> Vec<AgentTeam> {
        self.teams.lock().unwrap().clone()
    }

    /// Get a specific team.
    pub fn get_team(&self, team_id: &str) -> Option<AgentTeam> {
        self.teams.lock().unwrap().iter().find(|t| t.id == team_id).cloned()
    }

    /// Update a sub-agent's state within a team.
    pub fn update_agent_state(
        &self,
        team_id: &str,
        agent_id: &str,
        state: AgentState,
        output: Option<String>,
    ) -> bool {
        let mut guard = self.teams.lock().unwrap();
        if let Some(team) = guard.iter_mut().find(|t| t.id == team_id) {
            if let Some(agent) = team.agents.iter_mut().find(|a| a.id == agent_id) {
                agent.state = state;
                if output.is_some() {
                    agent.output = output;
                }
                if matches!(agent.state, AgentState::Completed | AgentState::Failed(_)) {
                    agent.finished_at_ms = Some(now_ms());
                }
                return true;
            }
        }
        false
    }

    /// Send a message between agents.
    pub fn send_message(&self, from: &str, to: &str, content: &str) {
        self.messages.lock().unwrap().push(AgentMessage {
            from_agent_id: String::from(from),
            to_agent_id: String::from(to),
            content: String::from(content),
            at_ms: now_ms(),
        });
    }

    /// Get messages for a specific agent.
    pub fn messages_for(&self, agent_id: &str) -> Vec<AgentMessage> {
        self.messages
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.to_agent_id == agent_id)
            .cloned()
            .collect()
    }

    /// Check if all agents in a team have completed.
    pub fn team_completed(&self, team_id: &str) -> bool {
        let guard = self.teams.lock().unwrap();
        guard
            .iter()
            .find(|t| t.id == team_id)
            .map(|team| {
                team.agents
                    .iter()
                    .all(|a| matches!(a.state, AgentState::Completed | AgentState::Failed(_)))
            })
            .unwrap_or(false)
    }

    /// Generate a summary of the team's work.
    pub fn team_summary(&self, team_id: &str) -> Option<String> {
        let guard = self.teams.lock().unwrap();
        let team = guard.iter().find(|t| t.id == team_id)?;
        let mut lines = vec![format!("Team: {} — Goal: {}", team.id, team.goal)];
        for agent in &team.agents {
            let status = match &agent.state {
                AgentState::Idle => "idle",
                AgentState::Running => "running",
                AgentState::Completed => "completed",
                AgentState::Failed(reason) => reason.as_str(),
            };
            let output_preview = agent
                .output
                .as_deref()
                .map(|o| {
                    if o.len() > 200 {
                        format!("{}...", &o[..200])
                    } else {
                        o.to_string()
                    }
                })
                .unwrap_or_default();
            lines.push(format!(
                "  [{}] {} ({}): {} {}",
                agent.id,
                agent.role.as_str(),
                agent.session_id,
                status,
                output_preview
            ));
        }
        Some(lines.join("\n"))
    }
}

fn default_system_prompt(role: &AgentRole) -> String {
    match role {
        AgentRole::Architect => String::from(
            "You are the Architect agent. Analyze the goal, break it into sub-tasks, \
             define the implementation plan, and specify acceptance criteria."
        ),
        AgentRole::Executor => String::from(
            "You are the Executor agent. Implement the plan provided by the Architect. \
             Make concrete code changes and run validations."
        ),
        AgentRole::Reviewer => String::from(
            "You are the Reviewer agent. Review the changes made by the Executor. \
             Check for correctness, style, security issues, and suggest improvements."
        ),
        AgentRole::Custom(name) => format!(
            "You are a custom agent with role '{name}'. Follow the coordinator's instructions."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_team_and_list() {
        let engine = CoordinatorEngine::new();
        let team = engine.create_team("fix bug", &[AgentRole::Architect, AgentRole::Executor]);
        assert_eq!(team.agents.len(), 2);
        assert_eq!(team.goal, "fix bug");
        assert_eq!(engine.list_teams().len(), 1);
    }

    #[test]
    fn delete_team() {
        let engine = CoordinatorEngine::new();
        let team = engine.create_team("task", &[AgentRole::Reviewer]);
        assert!(engine.delete_team(&team.id));
        assert!(engine.list_teams().is_empty());
    }

    #[test]
    fn update_agent_state() {
        let engine = CoordinatorEngine::new();
        let team = engine.create_team("task", &[AgentRole::Executor]);
        let agent_id = team.agents[0].id.clone();
        assert!(engine.update_agent_state(&team.id, &agent_id, AgentState::Running, None));
        assert!(engine.update_agent_state(
            &team.id,
            &agent_id,
            AgentState::Completed,
            Some("done".into())
        ));
        let updated = engine.get_team(&team.id).unwrap();
        assert_eq!(updated.agents[0].state, AgentState::Completed);
        assert_eq!(updated.agents[0].output.as_deref(), Some("done"));
    }

    #[test]
    fn send_and_receive_messages() {
        let engine = CoordinatorEngine::new();
        engine.send_message("a1", "a2", "hello from a1");
        engine.send_message("a2", "a1", "reply from a2");
        assert_eq!(engine.messages_for("a2").len(), 1);
        assert_eq!(engine.messages_for("a1").len(), 1);
        assert_eq!(engine.messages_for("a1")[0].content, "reply from a2");
    }

    #[test]
    fn team_completed_check() {
        let engine = CoordinatorEngine::new();
        let team = engine.create_team("build", &[AgentRole::Architect, AgentRole::Executor]);
        assert!(!engine.team_completed(&team.id));
        for agent in &team.agents {
            engine.update_agent_state(&team.id, &agent.id, AgentState::Completed, None);
        }
        assert!(engine.team_completed(&team.id));
    }

    #[test]
    fn team_summary_format() {
        let engine = CoordinatorEngine::new();
        let team = engine.create_team("deploy", &[AgentRole::Reviewer]);
        let summary = engine.team_summary(&team.id).unwrap();
        assert!(summary.contains("deploy"));
        assert!(summary.contains("reviewer"));
    }
}
