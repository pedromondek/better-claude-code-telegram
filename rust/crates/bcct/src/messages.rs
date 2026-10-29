mod en_us;
mod pt_br;

use crate::locale::Locale;

#[derive(Debug, Clone, Copy)]
pub struct StepLabels {
    pub token: &'static str,
    pub pairing: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct StepTitles {
    pub language: &'static str,
    pub plugin: &'static str,
    pub token: &'static str,
    pub pairing: &'static str,
    pub delay: &'static str,
    pub quiet_hours: &'static str,
    pub transcription: &'static str,
    pub inbox: &'static str,
    pub statusline: &'static str,
    pub health: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct SettingsKeys {
    pub status_line: &'static str,
    pub permissions: &'static str,
    pub enabled_plugins: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct ChangeKinds {
    pub file_created: fn(&str) -> String,
    pub file_changed: fn(&str) -> String,
    pub dir_created: fn(&str) -> String,
    pub marketplace_added: fn(&str) -> String,
    pub plugin_installed: fn(&str) -> String,
    pub plugin_removed: fn(&str) -> String,
    pub tool_installed: fn(&str) -> String,
}

#[derive(Debug, Clone, Copy)]
pub struct SettingHints {
    pub language: &'static str,
    pub delay: &'static str,
    pub quiet_hours: &'static str,
    pub transcription: &'static str,
    pub inbox: &'static str,
    pub statusline: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct HealthGroupTitles {
    pub install: &'static str,
    pub telegram: &'static str,
    pub security: &'static str,
    pub extras: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct HealthLabels {
    pub node: &'static str,
    pub user: &'static str,
    pub claude: &'static str,
    pub bun: &'static str,
    pub plugins: &'static str,
    pub shell: &'static str,
    pub token: &'static str,
    pub groups: &'static str,
    pub pairing: &'static str,
    pub polling: &'static str,
    pub protection: &'static str,
    pub config: &'static str,
    pub transcription: &'static str,
    pub mermaid: &'static str,
    pub statusline: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct StatuslineDetail {
    pub ours: &'static str,
    pub ours_after: &'static str,
    pub other: &'static str,
    pub none: &'static str,
    pub custom: &'static str,
    pub custom_pending: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct HealthDetail {
    pub version: fn(&str) -> String,
    pub found: &'static str,
    pub missing: &'static str,
    pub installed: &'static str,
    pub not_installed: fn(&str) -> String,
    pub loaded_in: fn(&str) -> String,
    pub not_loaded: fn(&str) -> String,
    pub bot: fn(&str) -> String,
    pub no_token: &'static str,
    pub paired: fn(&str) -> String,
    pub not_paired: &'static str,
    pub not_allowlist: fn(&str) -> String,
    pub pending_pairings: fn(u64) -> String,
    pub groups_allowed: fn(u64) -> String,
    pub groups_off: &'static str,
    pub groups_unknown: &'static str,
    pub regular_user: &'static str,
    pub root: &'static str,
    pub connected: &'static str,
    pub not_open: &'static str,
    pub connecting: &'static str,
    pub down: &'static str,
    pub protected: &'static str,
    pub unprotected: fn(&str) -> String,
    pub valid: &'static str,
    pub invalid: fn(&str) -> String,
    pub off: &'static str,
    pub model: fn(&str) -> String,
    pub broken: fn(&str) -> String,
    pub statusline: StatuslineDetail,
}

#[derive(Debug, Clone, Copy)]
pub struct BcctChoices {
    pub keep: &'static str,
    pub remove: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct BcctHints {
    pub keep: &'static str,
    pub remove: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct PairingChoices {
    pub keep: &'static str,
    pub replace: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct QuietPresets {
    pub outside_work: &'static str,
    pub full_night: &'static str,
    pub night: &'static str,
    pub late_night: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct TranscriptionModels {
    pub base: &'static str,
    pub small: &'static str,
    pub medium: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct StatuslineChoices {
    pub after: &'static str,
    pub replace: &'static str,
    pub custom: &'static str,
    pub keep: &'static str,
    pub keep_custom: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct StatuslineChoiceHints {
    pub after: &'static str,
    pub replace: &'static str,
    pub custom: &'static str,
    pub keep: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct StatuslineOursChoices {
    pub keep: &'static str,
    pub remove: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct StatuslineOursHints {
    pub keep: &'static str,
    pub restore: &'static str,
    pub remove: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct Messages {
    pub status_main: &'static str,
    pub status_secondary: &'static str,
    pub status_connected: fn(&str) -> String,
    pub status_down: fn(&str) -> String,
    pub status_connecting: fn(&str) -> String,
    pub step_labels: StepLabels,
    pub step_titles: StepTitles,
    pub health_has_failures: fn(&str) -> String,
    pub not_configured: fn(&str, &str) -> String,
    pub already_running: fn(&str) -> String,
    pub unknown_steps: fn(&str, &str) -> String,
    pub network_failure: fn(&str) -> String,
    pub telegram_refused: fn(&str, &str) -> String,
    pub no_description: &'static str,
    pub failed: fn(&str) -> String,
    pub yes_no_hint: fn(bool) -> String,
    pub default_hint: fn(&str) -> String,
    pub language_default_hint: fn(&str) -> String,
    pub select_hint: &'static str,
    pub yes: &'static str,
    pub no: &'static str,
    pub custom: &'static str,
    pub recommended: &'static str,
    pub previous_choice: &'static str,
    pub invalid_answer: fn(&str, &str) -> String,
    pub enter_keeps_default: &'static str,
    pub cancelled: &'static str,
    pub exit_prompt: &'static str,
    pub continue_setup: &'static str,
    pub exit_setup: &'static str,
    pub interrupted: &'static str,
    pub nothing_changed: &'static str,
    pub done_so_far: fn(&str) -> String,
    pub undo_prompt: &'static str,
    pub undo_all: &'static str,
    pub keep_done: &'static str,
    pub undone: &'static str,
    pub undo_left: fn(&str) -> String,
    pub kept_done: fn(&str) -> String,
    pub changed_setting: fn(&str, &str, &str) -> String,
    pub not_set: &'static str,
    pub rule_on: &'static str,
    pub rule_off: &'static str,
    pub plugin_on: &'static str,
    pub plugin_off: &'static str,
    pub plugin_setting: fn(&str) -> String,
    pub undoing: fn(&str) -> String,
    pub undone_item: fn(&str) -> String,
    pub settings_keys: SettingsKeys,
    pub change_kinds: ChangeKinds,
    pub tools_declined: fn(&str) -> String,
    pub invalid_setting: fn(&str, &str, &str) -> String,
    pub setting_hints: SettingHints,
    pub inbox_question: &'static str,
    pub inbox_days_label: fn(u64) -> String,
    pub inbox_forever_label: &'static str,
    pub inbox_custom_prompt: &'static str,
    pub inbox_custom_hint: &'static str,
    pub inbox_saved: fn(&str, &str) -> String,
    pub inbox_kept: fn(&str) -> String,
    pub language_kept: fn(&str) -> String,
    pub delay_kept: fn(f64) -> String,
    pub quiet_kept: fn(&str) -> String,
    pub transcription_model_kept: fn(&str) -> String,
    pub transcription_kept_off: &'static str,
    pub transcription_switched: fn(&str) -> String,
    pub remove_models_question: &'static str,
    pub remove_models_keep: &'static str,
    pub remove_models_all: fn(&str) -> String,
    pub remove_model: fn(&str) -> String,
    pub model_in_use: &'static str,
    pub model_used_until_now: &'static str,
    pub transcription_uninstall: &'static str,
    pub transcription_installed_heading: &'static str,
    pub transcription_available_heading: &'static str,
    pub models_removed: fn(&str) -> String,
    pub inbox_days: fn(u64) -> String,
    pub inbox_forever: &'static str,
    pub not_settable: fn(&str, &str) -> String,
    pub unknown_health_groups: fn(&str, &str) -> String,
    pub health_group_titles: HealthGroupTitles,
    pub health_labels: HealthLabels,
    pub health_detail: HealthDetail,
    pub install_tool_prompt: fn(&str, &str) -> String,
    pub tool_installed: fn(&str, &str) -> String,
    pub install_failed: fn(&str) -> String,
    pub tool_still_missing: fn(&str, &str) -> String,
    pub node_too_old: fn(&str, &str) -> String,
    pub bcct_prompt: &'static str,
    pub bcct_installed_question: &'static str,
    pub bcct_choices: BcctChoices,
    pub bcct_hints: BcctHints,
    pub plugins_checked: &'static str,
    pub required_plugins: fn(u64, u64) -> String,
    pub optional_plugins: fn(u64, u64) -> String,
    pub marketplace_found: &'static str,
    pub marketplace_missing: &'static str,
    pub plan_header: &'static str,
    pub plan_marketplace: fn(&str) -> String,
    pub plan_plugin: fn(&str) -> String,
    pub plan_shell_line: fn(&str) -> String,
    pub plan_prompt: &'static str,
    pub nothing_installed: &'static str,
    pub by_hand: &'static str,
    pub marketplace_added: fn(&str) -> String,
    pub plugins_checking: &'static str,
    pub marketplace_adding: fn(&str) -> String,
    pub plugin_installing: fn(&str) -> String,
    pub plugin_removing: fn(&str) -> String,
    pub plugin_enabling: fn(&str) -> String,
    pub plugin_disabling: fn(&str) -> String,
    pub plugin_added: fn(&str) -> String,
    pub marketplace_registered: fn(&str) -> String,
    pub plugin_installed: fn(&str) -> String,
    pub plugin_disabled_outside: fn(&str) -> String,
    pub plugin_enabled: fn(&str) -> String,
    pub plugin_already_disabled_outside: fn(&str) -> String,
    pub plugin_already_enabled: fn(&str) -> String,
    pub rc_already_loads: fn(&str) -> String,
    pub rc_now_loads: fn(&str) -> String,
    pub shell_unsupported: fn(&str, &str) -> String,
    pub rc_no_longer_loads: fn(&str) -> String,
    pub statusline_removed: fn(&str) -> String,
    pub env_rule_removed: fn(&str) -> String,
    pub env_protected: fn(&str, &str) -> String,
    pub env_already_protected: fn(&str, &str) -> String,
    pub plugin_removed: fn(&str) -> String,
    pub plugin_not_removed: fn(&str) -> String,
    pub plugin_not_installed: fn(&str) -> String,
    pub marketplace_removed: fn(&str) -> String,
    pub marketplace_not_removed: fn(&str) -> String,
    pub marketplace_not_registered: fn(&str) -> String,
    pub claude_missing_for_uninstall: fn(&str) -> String,
    pub close_instance_before_uninstall: &'static str,
    pub transcription_found: fn(&str) -> String,
    pub delete_transcription_prompt: &'static str,
    pub transcription_removed: &'static str,
    pub transcription_kept: &'static str,
    pub delete_mermaid_prompt: &'static str,
    pub mermaid_removed: &'static str,
    pub mermaid_not_removed: fn(&str) -> String,
    pub delete_state_prompt: fn(&str, &str) -> String,
    pub state_deleted: fn(&str, &str) -> String,
    pub state_kept: fn(&str, &str) -> String,
    pub uninstall_done: &'static str,
    pub no_saved_token: fn(&str) -> String,
    pub use_saved_bot: fn(&str) -> String,
    pub token_prompt: &'static str,
    pub token_saved: fn(&str, &str) -> String,
    pub no_pairing_message: &'static str,
    pub already_paired: fn(&str) -> String,
    pub pairing_choice_question: fn(&str) -> String,
    pub pairing_choices: PairingChoices,
    pub too_many_accounts: fn(u64, &str) -> String,
    pub permissions_skipped: fn(&str) -> String,
    pub groups_warning: fn(&str) -> String,
    pub close_instance_before_pairing: &'static str,
    pub webhook_configured: fn(&str) -> String,
    pub send_pairing_code: fn(&str, &str, &str) -> String,
    pub confirm_pairing: fn(&str, u64) -> String,
    pub pairing_cancelled: &'static str,
    pub paired_chat_message: &'static str,
    pub paired_with: fn(&str) -> String,
    pub delay_question: &'static str,
    pub delay_label: fn(f64) -> String,
    pub delay_custom_prompt: &'static str,
    pub delay_custom_hint: &'static str,
    pub delay_saved: fn(f64, &str) -> String,
    pub quiet_question: &'static str,
    pub quiet_off_label: &'static str,
    pub quiet_presets: QuietPresets,
    pub quiet_start_prompt: &'static str,
    pub quiet_end_prompt: &'static str,
    pub time_hint: &'static str,
    pub quiet_end_hint: fn(&str) -> String,
    pub quiet_saved: fn(&str, &str) -> String,
    pub quiet_off: &'static str,
    pub transcription_purpose: &'static str,
    pub transcription_question: &'static str,
    pub transcription_off_label: &'static str,
    pub transcription_models: TranscriptionModels,
    pub transcription_disabled: &'static str,
    pub python_env_failed: &'static str,
    pub install_whisper: &'static str,
    pub downloading_model: fn(&str) -> String,
    pub model_download: &'static str,
    pub saved_bot_checking: &'static str,
    pub token_checking: &'static str,
    pub paired_account_checking: &'static str,
    pub pairing_preparing: &'static str,
    pub pairing_waiting: &'static str,
    pub pairing_finishing: &'static str,
    pub whisper_env_creating: &'static str,
    pub whisper_installing: &'static str,
    pub model_removing: fn(&str) -> String,
    pub marketplace_removing: fn(&str) -> String,
    pub transcription_removing: &'static str,
    pub mermaid_removing: &'static str,
    pub transcription_ready: fn(&str) -> String,
    pub language_question: &'static str,
    pub language_saved: fn(&str, &str) -> String,
    pub statusline_prompt: fn(&str) -> String,
    pub statusline_installed: fn(&str) -> String,
    pub statusline_kept: &'static str,
    pub statusline_skipped: &'static str,
    pub statusline_choice_question: fn(&str, &str) -> String,
    pub statusline_choices: StatuslineChoices,
    pub statusline_choice_hints: StatuslineChoiceHints,
    pub statusline_custom_kept: &'static str,
    pub statusline_custom_requested: &'static str,
    pub statusline_custom_needs_own: &'static str,
    pub statusline_custom_prompt: fn(&str, &str, &str, &str) -> String,
    pub statusline_custom_left: fn(&str) -> String,
    pub statusline_chained: fn(&str) -> String,
    pub statusline_replaced: fn(&str, &str) -> String,
    pub statusline_already: &'static str,
    pub statusline_ours_question: fn(&str) -> String,
    pub statusline_ours_choices: StatuslineOursChoices,
    pub statusline_ours_hints: StatuslineOursHints,
    pub statusline_ours_kept: &'static str,
    pub statusline_restored: fn(&str) -> String,
    pub settings_invalid: fn(&str) -> String,
    pub done_all: &'static str,
    pub done_reopen: &'static str,
    pub done_live: &'static str,
    pub question_released: fn(&str, &str) -> String,
    pub nothing_pending: fn(Option<&str>) -> String,
    pub file_not_saved: fn(&str) -> String,
    pub file_not_removed: fn(&str) -> String,
    pub statusline_not_shown: &'static str,
    pub health_not_shown: &'static str,
}

pub const EN_US: Messages = en_us::MESSAGES;
pub const PT_BR: Messages = pt_br::MESSAGES;

#[must_use]
pub fn messages_for(locale: Locale) -> &'static Messages {
    match locale {
        Locale::EnUs => &EN_US,
        Locale::PtBr => &PT_BR,
    }
}
