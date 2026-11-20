// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#![allow(
    clippy::missing_panics_doc,
    clippy::missing_errors_doc,
    clippy::module_name_repetitions,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::similar_names,
    clippy::struct_excessive_bools,
    clippy::must_use_candidate,
    clippy::significant_drop_tightening,
    clippy::future_not_send,
    clippy::redundant_pub_crate,
    clippy::unreadable_literal,
    clippy::needless_pass_by_value,
    clippy::match_same_arms,
    clippy::option_if_let_else,
    clippy::manual_let_else,
    clippy::uninlined_format_args,
    clippy::unnecessary_wraps,
    clippy::cast_lossless,
    clippy::imprecise_flops,
    clippy::suboptimal_flops,
    clippy::needless_borrow,
    clippy::needless_pass_by_ref_mut,
    clippy::explicit_iter_loop,
    clippy::redundant_closure_for_method_calls,
    clippy::cognitive_complexity,
    clippy::single_match_else,
    clippy::map_unwrap_or,
    clippy::items_after_statements,
    clippy::or_fun_call,
    clippy::used_underscore_binding,
    clippy::unused_self,
    clippy::doc_markdown,
    clippy::collapsible_else_if,
    clippy::derive_partial_eq_without_eq,
    clippy::let_underscore_untyped,
    clippy::missing_const_for_fn,
    clippy::semicolon_if_nothing_returned,
    clippy::trivially_copy_pass_by_ref,
    clippy::float_cmp,
    clippy::branches_sharing_code,
    clippy::unnecessary_safety_doc,
    clippy::blocks_in_conditions,
    clippy::iter_with_drain,
    clippy::case_sensitive_file_extension_comparisons,
    clippy::use_self,
    clippy::significant_drop_in_scrutinee,
    clippy::ignored_unit_patterns,
    clippy::equatable_if_let,
    clippy::if_not_else
)]

mod agent;
mod app;
mod capture;
mod db;
mod shortcuts;
mod speech;
mod tools;
mod window;

use capture::CaptureState;
use tauri::Manager;

/// Piely: an always-on-top overlay that answers questions and listens to
/// system audio. The work lives in the modules above; `run` only wires them up.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus the existing overlay instead of duplicating it
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:piely.db", db::migrations())
                .build(),
        )
        .manage(speech::system_audio::AudioState::default())
        .manage(CaptureState::default())
        .manage(shortcuts::WindowVisibility {
            is_hidden: std::sync::Mutex::new(false),
        })
        .manage(shortcuts::RegisteredShortcuts::default())
        .manage(shortcuts::MoveWindowState::default())
        .manage(agent::PielyState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_machine_uid::init());
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            app::get_app_version,
            app::log_frontend_error,
            window::set_window_height,
            window::open_dashboard,
            window::toggle_dashboard,
            window::move_window,
            window::set_app_icon_visibility,
            window::set_always_on_top,
            capture::capture_to_base64,
            capture::start_screen_capture,
            capture::capture_selected_area,
            capture::close_overlay_window,
            shortcuts::check_shortcuts_registered,
            shortcuts::get_registered_shortcuts,
            shortcuts::update_shortcuts,
            shortcuts::validate_shortcut_key,
            shortcuts::exit_app,
            agent::piely_list_providers,
            agent::piely_get_models,
            agent::piely_login,
            agent::piely_login_answer,
            agent::piely_login_cancel,
            agent::piely_logout,
            agent::piely_chat_stream,
            agent::piely_cancel_stream,
            tools::tools_find_files,
            tools::tools_search_files_content,
            tools::tools_list_directory,
            tools::tools_read_file,
            tools::tools_write_file,
            tools::tools_list_apps,
            tools::tools_open_path,
            tools::tools_open_app,
            speech::local_transcribe,
            speech::system_audio::start_system_audio_capture,
            speech::system_audio::stop_system_audio_capture,
            speech::system_audio::manual_stop_continuous,
            speech::system_audio::check_system_audio_access,
            speech::system_audio::request_system_audio_access,
            speech::system_audio::update_vad_config,
            speech::system_audio::get_input_devices,
            speech::system_audio::get_output_devices,
        ])
        .setup(app::setup);

    // Add macOS-specific permissions plugin
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_permissions::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
