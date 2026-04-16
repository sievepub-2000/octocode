use octocode_core::{permission_allows, OctoError, PermissionMode, PermissionPolicy};

#[derive(Debug, Default, Clone, Copy)]
pub struct RuntimePermissionPolicy;

impl PermissionPolicy for RuntimePermissionPolicy {
    fn ensure_allowed(
        &self,
        current: &PermissionMode,
        required: &PermissionMode,
        scope: &str,
    ) -> Result<(), OctoError> {
        if permission_allows(current, required) {
            Ok(())
        } else {
            Err(OctoError::Runtime(format!(
                "permission denied for {scope}: required {:?}, current {:?}",
                required, current
            )))
        }
    }
}