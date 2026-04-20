use std::fs;
use std::path::PathBuf;

use octocode_core::{SkillDescriptor, SkillScope};

pub struct SkillRegistry {
    skills: Vec<SkillDescriptor>,
}

impl SkillRegistry {
    pub fn discover(workspace_root: &str, config_home: &str) -> Result<Self, String> {
        let roots = [
            (PathBuf::from(workspace_root).join("skills"), SkillScope::Workspace),
            (
                PathBuf::from(workspace_root).join(".claude").join("skills"),
                SkillScope::Workspace,
            ),
            (PathBuf::from(config_home).join("skills"), SkillScope::User),
        ];

        let mut skills = Vec::new();
        for (root, scope) in roots {
            if !root.is_dir() {
                continue;
            }
            let entries = fs::read_dir(&root)
                .map_err(|error| format!("failed to read skills dir {}: {error}", root.display()))?;
            for entry in entries {
                let entry = entry.map_err(|error| {
                    format!("failed to read skill entry in {}: {error}", root.display())
                })?;
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let skill_file = path.join("SKILL.md");
                if !skill_file.is_file() {
                    continue;
                }
                skills.push(parse_skill(&skill_file, &scope)?);
            }
        }

        skills.sort_by(|left, right| left.id.cmp(&right.id));
        skills.dedup_by(|left, right| left.id == right.id && left.scope == right.scope);
        Ok(Self { skills })
    }

    pub fn skills(&self) -> &[SkillDescriptor] {
        &self.skills
    }

    pub fn into_skills(self) -> Vec<SkillDescriptor> {
        self.skills
    }
}

fn parse_skill(path: &PathBuf, scope: &SkillScope) -> Result<SkillDescriptor, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("failed to read skill file {}: {error}", path.display()))?;
    let fallback_id = path
        .parent()
        .and_then(|value| value.file_name())
        .and_then(|value| value.to_str())
        .unwrap_or("skill")
        .to_string();
    let mut id = fallback_id.clone();
    let mut summary = String::from("local skill");

    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("name:") {
            id = value.trim().trim_matches('"').trim_matches('\'').to_string();
        } else if let Some(value) = trimmed.strip_prefix("description:") {
            summary = value.trim().trim_matches('"').trim_matches('\'').to_string();
        }
    }

    Ok(SkillDescriptor {
        id,
        summary,
        path: path.display().to_string(),
        scope: scope.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::SkillRegistry;
    use octocode_core::SkillScope;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_path(suffix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("octocode-skills-{suffix}-{stamp}"))
    }

    #[test]
    fn discovers_workspace_and_user_skills() {
        let workspace_root = unique_path("workspace");
        let config_root = unique_path("config");
        let workspace_skill = workspace_root.join("skills").join("spec-kit");
        let user_skill = config_root.join("skills").join("local-helper");
        fs::create_dir_all(&workspace_skill).expect("create workspace skill dir");
        fs::create_dir_all(&user_skill).expect("create user skill dir");
        fs::write(
            workspace_skill.join("SKILL.md"),
            "---\nname: spec-kit\ndescription: spec discipline\n---\n",
        )
        .expect("write workspace skill");
        fs::write(
            user_skill.join("SKILL.md"),
            "---\nname: local-helper\ndescription: user local helper\n---\n",
        )
        .expect("write user skill");

        let registry = SkillRegistry::discover(
            workspace_root.to_str().expect("workspace path"),
            config_root.to_str().expect("config path"),
        )
        .expect("discover skills");

        assert_eq!(registry.skills().len(), 2);
        assert!(registry
            .skills()
            .iter()
            .any(|skill| skill.id == "spec-kit" && skill.scope == SkillScope::Workspace));
        assert!(registry
            .skills()
            .iter()
            .any(|skill| skill.id == "local-helper" && skill.scope == SkillScope::User));

        let _ = fs::remove_dir_all(&workspace_root);
        let _ = fs::remove_dir_all(&config_root);
    }
}
