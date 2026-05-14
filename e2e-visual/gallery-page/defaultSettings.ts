// Frozen v0.5.0 Settings defaults used by the visual-regression
// gallery page. The compile-time contract is double-typed: the
// explicit `: Settings` return type AND `satisfies Settings` on the
// returned literal — together they make a missing required key a
// compile error AND let the literal expose its keys for introspection.

import type {
  Settings,
} from '../../src/types-generated';

export function defaultSettings(): Settings {
  return ({
    profile: { user_id: 'gallery', display_name: '', color: '#888888' },
    appearance: {
      theme: 'light',
      font_size_px: 14,
      line_height: 150,
      density: 'comfortable',
      startup_mode: 'clean',
      dark_variant: 'pure',
    },
    editor: {
      default_open_mode: 'render',
      auto_save: false,
      auto_save_debounce_ms: 750,
      external_change_behavior: 'ask',
      syntax_highlighting: true,
      mermaid_enabled: true,
      show_whitespace: false,
      word_wrap: true,
      render_readonly: false,
      caret_in_block_behavior: 'collapse-widget',
      paste_html_behavior: 'plain',
      idle_reanchor_ms: 1500,
    },
    comments: {
      auto_merge: 'always',
      reattachment_confidence: 75,
      sidecar_pattern: '{name}.md.comments.json',
      show_resolved: false,
    },
    advanced: { sync_provider: null, verbose_logs: false },
    shortcuts: {},
    cloud: {
      drive: {
        feature_enabled: false,
        connected: false,
        account_email: null,
        backend_mode: 'auto',
        poll_interval_active_secs: 0n,
        poll_interval_unfocused_secs: 0n,
        custom_oauth_client_id: null,
        detect_toast_suppressed: false,
      },
    },
    onboarding: { cli_install_prompt_seen_for: '' },
  } satisfies Settings);
}
