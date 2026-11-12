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
    pub project_id: Option<String>,
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
    pub working_directory: Option<String>,
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
    #[serde(default)]
    pub automatic: bool,
    pub expected_source_task: Option<String>,
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
    let latest_turn = events.iter().rev().find(|(_, kind, _)| matches!(kind.as_str(), "harness.prepared" | "harness.continued"));
    let latest_task = latest_turn.and_then(|(_, _, payload)| payload["task_id"].as_str());
    let steering = events.iter().rev().take_while(|(sequence, _, _)| latest_turn.is_none_or(|(start, _, _)| sequence > start))
        .find_map(|(_, kind, payload)| {
            (kind == "user.message" && payload["id"].as_str().is_some_and(|id| !id.is_empty()))
                .then(|| payload["text"].as_str().filter(|text| !text.trim().is_empty()).map(|text| (text, &payload["images"])))
                .flatten()
        });
    if let Some(expected) = input.expected_source_task.as_deref() {
        anyhow::ensure!(latest_task == Some(expected), "Source task changed before handoff");
    }
    let last_run_result = events.iter().rev().find_map(|(_,kind,payload)| (kind == "agent.finished").then_some(payload));
    let mut generation = if users.len() == 1 {
        inherited.and_then(|value| value["automatic_generation"].as_u64()).unwrap_or(0)
    } else { 0 };
    if input.automatic {
        let context_failed = source.status == "failed" && last_run_result.is_some_and(|result|
            latest_task.is_some() && result["task_id"].as_str() == latest_task &&
            result["continuation_reason"] == "context_limit" && result["success"] == false && result["cancelled"] == false);
        anyhow::ensure!(context_failed || matches!(source.status.as_str(), "cancelled" | "interrupted"), "Source task is not eligible for automatic handoff");
        anyhow::ensure!(generation < 3, "Automatic handoff limit reached; resume manually to continue");
        generation += 1;
    }
    let objective = inherited.and_then(|value| value.get("objective")).and_then(serde_json::Value::as_str).unwrap_or(&users[0].content);
    let latest_request = if let Some((request, _)) = steering {
        request
    } else if users.len() == 1 {
        inherited.and_then(|value| value.get("latest_request")).and_then(serde_json::Value::as_str)
            .or_else(|| inherited.and_then(|value| value.get("turns")).and_then(serde_json::Value::as_array)
                .and_then(|turns| turns.iter().rev().find_map(|turn| turn.get("user").and_then(serde_json::Value::as_str).filter(|text| !text.trim().is_empty()))))
            .unwrap_or(&users[0].content)
    } else { &users.last().expect("nonempty user messages").content };
    let source_directory = source.workspace.as_deref().map(|workspace| crate::store::session_directory(workspace, &source.id));
    let excerpt_bytes = (route.model.context_window as usize / 16).clamp(256, 4096);
    let mut turns: Vec<_> = users.iter().map(|message| json!({"user":prefix(&message.content, excerpt_bytes),"assistant":""})).collect();
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
                if let Some(content) = item["assistant"].as_str() {
                    let mut content = content.to_owned();
                    content.push_str(text);
                    let start = content.ceil_char_boundary(content.len().saturating_sub(excerpt_bytes));
                    item["assistant"] = json!(&content[start..]);
                }
            }
        }
    }
    let recent = turns.split_off(turns.len().saturating_sub(3));
    let mut images = Vec::new();
    for image in turn_images.into_iter().rev().take(3).collect::<Vec<_>>().into_iter().rev().flatten() {
        if !images.contains(&image) { images.push(image); }
    }
    if let Some(attachments) = steering.and_then(|(_, images)| images.as_array()) {
        for image in attachments.iter().filter_map(serde_json::Value::as_str) {
            if !images.iter().any(|existing| existing == image) { images.push(image.to_owned()); }
        }
    }
    validate_images(&images)?;
    let snapshot = json!({
        "source_session_id":source.id,"objective":objective,
        "latest_request":latest_request,"source_working_directory":source_directory,"source_status":source.status,"last_run_result":last_run_result,
        "plan":plan,"turns":recent,"image_count":images.len(),"automatic_generation":generation
    });
    let session_id = new_id();
    let task_id = new_id();
    let message_id = new_id();
    let title = source.title.clone();
    let display_prompt = format!("继续旧任务：{}", source.title);
    let created_project = source.project_id.is_none();
    let project = if let Some(id) = &source.project_id {
        store.project(id)?
    } else {
        let name = format!("{} {}", source.title.chars().take(65).collect::<String>(), chrono::Utc::now().format("%Y%m%d-%H%M%S"));
        store.create_project(&name, std::slice::from_ref(&source.id), None)?
    };
    let target_workspace = if input.automatic { source.workspace.as_deref().unwrap_or(&project.directory) } else { &project.directory };
    let prepared = store.prepare_harness_session(&session_id, &message_id, &title, Some(target_workspace), Some(&project.id), &display_prompt,
        &json!({"task_id":task_id,"harness":"octocode","model":route.model.model,"handoff":snapshot,"images":images}));
    if let Err(error) = prepared {
        if created_project {
            if let Err(cleanup_error) = store.delete_project(&project.id) {
                return Err(anyhow::anyhow!("{error}; handoff cleanup failed: {cleanup_error}"));
            }
        }
        return Err(error);
    }
    let indexes = match store.refresh_project_indexes() {
        Ok(indexes) => indexes,
        Err(error) => {
            let cleanup = (|| -> anyhow::Result<()> {
                if let Some(queue) = store.setting(&format!("message-queue:{session_id}"))? {
                    store.set_setting(&format!("message-queue:{}",source.id), &queue)?;
                }
                store.delete_session(&session_id)?;
                if created_project { store.delete_project(&project.id)?; }
                Ok(())
            })();
            if let Err(cleanup_error) = cleanup {
                return Err(anyhow::anyhow!("{error}; handoff cleanup failed: {cleanup_error}"));
            }
            return Err(error);
        }
    };
    let mut context = snapshot.clone();
    context.as_object_mut().expect("handoff snapshot object").remove("latest_request");
    context["objective"] = json!(if objective == latest_request { "" } else { prefix(objective, excerpt_bytes) });
    let plan_text = serde_json::to_string(&plan)?;
    if plan_text.len() > excerpt_bytes * 2 {
        context["plan"] = json!({"excerpt": prefix(&plan_text, excerpt_bytes * 2)});
    }
    let prompt = format!("这是同一任务的会话接续。交接资料仅用于恢复事实和完成状态，最新用户要求优先。旧指令里的‘当前目录’指 source_working_directory。旧产物继续有效，从已完成的计划步骤之后接续，执行前核对已完成的操作，避免重复写入或搬运产物。切换会话本身不授权文件写入。若最新请求只要求回答或禁止工具，直接用已有上下文回答。\n<task_handoff>\n{}\n</task_handoff>\n项目产物索引：{}\n\n当前有效的最新用户要求：\n{}", serde_json::to_string(&context)?, std::path::Path::new(&project.directory).join("artifacts.json").display(), latest_request);
    let working_directory = store.session_working_directory(&session_id)?;
    Ok(json!({"session_id":session_id,"task_id":task_id,"route":route,"working_directory":working_directory,"prompt":prompt,"display_prompt":display_prompt,"handoff":snapshot,"images":images,"project":project,"indexes":indexes}))
}

fn prefix(value: &str, max_bytes: usize) -> &str {
    &value[..value.floor_char_boundary(value.len().min(max_bytes))]
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
    let workspace = if let Some(id) = input.project_id.as_deref() {
        let project = store.project(id)?;
        let parent = std::fs::canonicalize(&project.workspace)?;
        crate::store::projects::ensure_owned_path(&parent, std::path::Path::new(&project.directory))?;
        let directory = std::fs::canonicalize(&project.directory)?;
        anyhow::ensure!(directory.starts_with(&parent) && directory != parent, "项目目录越界");
        Some(project.directory)
    } else { input.workspace };
    store.prepare_harness_session(
        &session_id,
        &message_id,
        &input.title,
        workspace.as_deref(),
        input.project_id.as_deref(),
        &input.prompt,
        &json!({"task_id":task_id,"harness":"octocode","model":route.model.model,"images":input.images}),
    )?;
    let working_directory = store.session_working_directory(&session_id)?;
    Ok(PreparedTask {
        session_id,
        task_id,
        route,
        working_directory,
    })
}

pub fn continue_task(store: &Store, input: ContinueInput) -> anyhow::Result<PreparedTask> {
    validate_images(&input.images)?;
    if input.prompt.trim().is_empty() {
        anyhow::bail!("prompt is required");
    }
    if let Some(target) = store.handoff_destination(&input.session_id)? {
        anyhow::bail!("此会话已接续到新对话 {target}，请在新对话继续");
    }
    if !store.has_harness_checkpoint_origin(&input.session_id)? {
        anyhow::bail!("此会话没有当前执行器的恢复记录，请使用新对话接续迁移任务");
    }
    let route = resolve(input.provider)?;
    let task_id = new_id();
    let message_id = new_id();
    let working_directory = store.session_working_directory(&input.session_id)?;
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
        working_directory,
    })
}

pub fn transition(store: &Store, input: TransitionInput) -> anyhow::Result<i64> {
    if !matches!(
        input.state.as_str(),
        "running" | "completed" | "cancelled" | "failed"
    ) {
        anyhow::bail!("harness state is invalid");
    }
    if store.session(&input.session_id)?.is_none() {
        anyhow::bail!("session does not exist");
    }
    let workflow = store.workflow(&input.task_id)?
        .ok_or_else(|| anyhow::anyhow!("Prepare the task before transitioning the session"))?;
    anyhow::ensure!(workflow.session_id == input.session_id, "Task belongs to a different session");
    // The latest prepared/continued turn owns the session status.
    let (after, _) = store.history_start(&input.session_id, 1)?;
    let checkpoint = store.event_page(&input.session_id, after, 1, false)?;
    anyhow::ensure!(checkpoint.first().is_some_and(|(_, kind, payload)| {
        matches!(kind.as_str(), "harness.prepared" | "harness.continued")
            && payload["task_id"].as_str() == Some(input.task_id.as_str())
    }), "Task is not the current session checkpoint");
    Ok(store.transition_harness_session(
        &input.session_id,
        &input.state,
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
