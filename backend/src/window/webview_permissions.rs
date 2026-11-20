//! Linux only: WebKitGTK refuses microphone access unless the app allows the
//! request itself. Windows and macOS need none of this.
use tauri::{Runtime, WebviewWindow};

#[cfg(target_os = "linux")]
pub fn enable_media_streams<R: Runtime>(window: &WebviewWindow<R>) {
    use webkit2gtk::glib::prelude::Cast;
    use webkit2gtk::{
        PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebViewExt,
    };

    let result = window.with_webview(|webview| {
        let webview = webview.inner();
        if let Some(settings) = webview.settings() {
            settings.set_enable_media_stream(true);
            settings.set_enable_mediasource(true);
            settings.set_enable_webaudio(true);
        }

        webview.connect_permission_request(|_, request| {
            if let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() {
                // Audio only: the app never asks for a camera.
                if media.is_for_audio_device() {
                    request.allow();
                    return true;
                }
            }
            false
        });
    });

    if let Err(error) = result {
        eprintln!("Failed to enable microphone access: {error}");
    }
}

/// No-op on platforms whose webview grants microphone access on its own.
#[cfg(not(target_os = "linux"))]
pub fn enable_media_streams<R: Runtime>(_window: &WebviewWindow<R>) {}
