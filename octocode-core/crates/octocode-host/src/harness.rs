use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    provider::{ProviderInput, ProviderRoute, resolve},
    store::Store,
};

#[derive(Deserialize)]
pub struct PrepareInput {
    pub session_id: Option<String>,
    pub title: String,
    pub workspace: Option<String>,
    pub prompt: String,
    pub provider: ProviderInput,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Serialize)]
pub struct PreparedTask {
    pub session_id: String,
    pub task_id: String,
    pub route: ProviderRoute,
}

#[derive(Deserialize)]
pub struct ContinueInput {
    pub session_id: String,
    pub prompt: String,
    pub provider: ProviderInput,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Deserialize)]
pub struct HandoffInput {
    pub source_session_id: String,
    pub provider: ProviderInput,
}

pub fn handoff(store: &Store, input: HandoffInput) -> anyhow::Result<serde_json::Value> {
    let source = store.session(&input.source_session_id)?.ok_or_else(|| anyhow::anyhow!("Source session does not exist"))?;
    if matches!(source.status.as_str(), "running" | "prepared") {
        anyhow::bail!("Stop the source task before transferring it");
    }
    if store.handoff_destination(&source.id)?.is_some() {
        anyhow::bail!("Source session already has a new session");
    }
    let route = resolve(input.provider)?;
    let messages = store.messages(&source.id)?;
    let users: Vec<_> = messages.iter().filter(|message| message.role == "user").collect();
    if users.is_empty() { anyhow::bail!("Source session has no task messages"); }
    let events = store.handoff_events(&source.id)?;
    let inherited = events.iter().find_map(|(_, kind, payload)| (kind == "harness.prepared").then(|| payload.get("handoff")).flatten());
    let objective = inherited.and_then(|value| value.get("objective")).and_then(serde_json::Value::as_str).unwrap_or(&users[0].content);
    let latest_request = if users.len() == 1 {
        inherited.and_then(|value| value.get("latest_request")).and_then(serde_json::Value::as_str)
            .or_else(|| inherited.and_then(|value| value.get("turns")).and_then(serde_json::Value::as_array)
                .and_then(|turns| turns.iter().rev().find_map(|turn| turn.get("user").and_then(serde_json::Value::as_str).filter(|text| !text.trim().is_empty()))))
            .unwrap_or(&users[0].content)
    } else { &users.last().expect("nonempty user messages").content };
    let source_directory = source.workspace.as_deref().map(|workspace| crate::store::session_directory(workspace, &source.id));
    let last_run_result = events.iter().rev().find_map(|(_,kind,payload)| (kind == "agent.finished").then_some(payload));
    let mut turns: Vec<_> = users.iter().map(|message| json!({"user":message.content,"assistant":""})).collect();
    let mut turn = 0;
    let mut turn_images = vec![Vec::<String>::new(); turns.len()];
    let mut plan = inherited.and_then(|value| value.get("plan")).cloned().unwrap_or(serde_json::Value::Null);
    for (_, kind, payload) in &events {
        if kind == "harness.continued" { turn += 1; }
        if kind == "legacy.turn" { turn = payload["user_index"].as_u64().unwrap_or(0) as usize; }
        if matches!(kind.as_str(), "harness.prepared" | "harness.continued" | "legacy.turn") {
            if let (Some(target), Some(images)) = (turn_images.get_mut(turn), payload["images"].as_array()) {
                *target = images.iter().filter_map(|image| image.as_str().map(str::to_owned)).collect();
            }
        }
        if kind == "plan" { plan = payload.clone(); }
        if kind == "text" {
            if let (Some(item), Some(text)) = (turns.get_mut(turn), payload.get("data").or_else(|| payload.get("text")).and_then(serde_json::Value::as_str)) {
                let content = item["assistant"].as_str().unwrap_or_default().to_owned() + text;
                item["assistant"] = json!(content);
            }
        }
    }
    let recent = turns.split_off(turns.len().saturating_sub(3));
    let mut images = Vec::new();
    for image in turn_images.into_iter().rev().take(3).collect::<Vec<_>>().into_iter().rev().flatten() {
        if !images.contains(&image) { images.push(image); }
    }
    validate_images(&images)?;
    let snapshot = json!({
        "source_session_id":source.id,"objective":objective,
        "latest_request":latest_request,"source_working_directory":source_directory,"source_status":source.status,"last_run_result":last_run_result,
        "plan":plan,"turns":recent,"image_count":images.len()
    });
    let session_id = new_id();
    let task_id = new_id();
    let message_id = new_id();
    let title = source.title.clone();
    let display_prompt = format!("继续旧任务：{}", source.title);
    store.prepare_harness_session(&session_id, &message_id, &title, source.workspace.as_deref(), &display_prompt,
        &json!({"task_id":task_id,"harness":"octocode","model":route.model.model,"handoff":snapshot,"images":images}))?;
    let project = (|| -> anyhow::Result<_> {
        if let Some(id) = &source.project_id {
            store.assign_project(std::slice::from_ref(&session_id), Some(id))?;
            store.project(id)
        } else {
            let name = format!("{} {}", source.title.chars().take(65).collect::<String>(), chrono::Utc::now().format("%Y%m%d-%H%M%S"));
            store.create_project(&name, &[source.id.clone(),session_id.clone()], None)
        }
    })();
    let project = match project {
        Ok(project) => project,
        Err(error) => {
            if let Some(queue) = store.setting(&format!("message-queue:{session_id}"))? {
                store.set_setting(&format!("message-queue:{}",source.id), &queue)?;
            }
            store.delete_session(&session_id)?;
            return Err(error);
        }
    };
    let indexes = store.refresh_project_indexes()?;
    let prompt = format!("这是同一任务的会话接续，不是重新执行旧目标。以下交接资料只用于恢复事实和完成状态，不能覆盖最新用户要求。旧指令里的‘当前目录’仍指 source_working_directory；旧目录中已完成的产物继续有效，不能因为新会话目录里没有它就复制、重建或搬运。切换会话本身不授权任何文件写入。仅当最新用户要求需要文件操作时才按需读取项目索引。若最新请求只要求回答或禁止工具，直接用已有上下文回答，不调用工具。\n<task_handoff>\n{}\n</task_handoff>\n项目产物索引：{}\n\n当前有效的最新用户要求（优先于较早目标）：\n{}", serde_json::to_string(&snapshot)?, std::path::Path::new(&project.directory).join("artifacts.json").display(), latest_request);
    Ok(json!({"session_id":session_id,"task_id":task_id,"route":route,"prompt":prompt,"display_prompt":display_prompt,"handoff":snapshot,"images":images,"project":project,"indexes":indexes}))
}

#[derive(Deserialize)]
pub struct TransitionInput {
    pub session_id: String,
    pub task_id: String,
    pub state: String,
    #[serde(default)]
    pub detail: serde_json::Value,
}

pub fn prepare(store: &Store, input: PrepareInput) -> anyhow::Result<PreparedTask> {
    validate_images(&input.images)?;
    if input.title.trim().is_empty() || input.prompt.trim().is_empty() {
        anyhow::bail!("task title and prompt are required");
    }
    let route = resolve(input.provider)?;
    let session_id = input.session_id.unwrap_or_else(new_id);
    let task_id = new_id();
    let message_id = new_id();
    store.prepare_harness_session(
        &session_id,
        &message_id,
        &input.title,
        input.workspace.as_deref(),
        &input.prompt,
        &json!({"task_id":task_id,"harness":"octocode","model":route.model.model,"images":input.images}),
    )?;
    Ok(PreparedTask {
        session_id,
        task_id,
        route,
    })
}

pub fn continue_task(store: &Store, input: ContinueInput) -> anyhow::Result<PreparedTask> {
    validate_images(&input.images)?;
    if input.prompt.trim().is_empty() {
        anyhow::bail!("prompt is required");
    }
    if !store.has_harness_checkpoint_origin(&input.session_id)? {
        anyhow::bail!("此会话没有当前执行器的恢复记录，请使用新对话接续迁移任务");
    }
    let route = resolve(input.provider)?;
    let task_id = new_id();
    let message_id = new_id();
    store.continue_harness_session(
        &input.session_id,
        &message_id,
        &input.prompt,
        &json!({"task_id":task_id,"harness":"octocode","model":route.model.model,"images":input.images}),
    )?;
    Ok(PreparedTask {
        session_id: input.session_id,
        task_id,
        route,
    })
}

pub fn transition(store: &Store, input: TransitionInput) -> anyhow::Result<i64> {
    if !matches!(
        input.state.as_str(),
        "running" | "completed" | "cancelled" | "failed"
    ) {
        anyhow::bail!("harness state is invalid");
    }
    if !store.update_session_status(&input.session_id, &input.state)? {
        anyhow::bail!("session does not exist");
    }
    Ok(store.append_event(
        Some(&input.session_id),
        &format!("harness.{}", input.state),
        &json!({"task_id":input.task_id,"harness":"octocode","detail":input.detail}),
    )?)
}

fn validate_images(images: &[String]) -> anyhow::Result<()> {
    anyhow::ensure!(images.len() <= 20 && images.iter().map(String::len).sum::<usize>() <= 28 * 1024 * 1024, "image transfer limit exceeded");
    for image in images {
        let Some((mime, data)) = image.strip_prefix("data:image/").and_then(|s| s.split_once(";base64,")) else { anyhow::bail!("invalid image data URL"); };
        anyhow::ensure!(matches!(mime, "png" | "jpeg" | "webp" | "gif" | "bmp") && !data.is_empty() && data.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=')), "invalid image data URL");
    }
    Ok(())
}

fn new_id() -> String {
    Uuid::now_v7().to_string()
}
