use std::sync::mpsc;
use std::thread::JoinHandle;

use crate::{Error, Mode, Watcher};
use futures_core::Stream;
use zbus::proxy;
use zbus::OwnedVariant;

const APPEARANCE: &str = "org.freedesktop.appearance";
const COLOR_SCHEME: &str = "color-scheme";
const PORTAL_DESTINATION: &str = "org.freedesktop.portal.Desktop";

#[proxy(
    interface = "org.freedesktop.portal.Settings",
    default_path = "/org/freedesktop/portal/desktop"
)]
pub trait XdgPortalSettings {
    fn read_one(&self, namespace: &str, key: &str) -> zbus::Result<OwnedVariant>;

    #[zbus(signal)]
    fn setting_changed(&self, namespace: &str, key: &str, value: OwnedVariant) -> zbus::Result<()>;
}

pub fn detect() -> Result<Mode, Error> {
    zbus::block_on(async {
        let conn = zbus::Connection::session()
            .await
            .map_err(|e| Error::XdgDesktopPortal(e.to_string()))?;
        let portal = XdgPortalSettingsProxy::new(&conn, PORTAL_DESTINATION)
            .await
            .map_err(|e| Error::XdgDesktopPortal(e.to_string()))?;
        let mode_value: u32 = portal
            .read_one(APPEARANCE, COLOR_SCHEME)
            .await
            .map_err(|e| Error::XdgDesktopPortal(e.to_string()))?
            .try_into()
            .map_err(|_| Error::XdgDesktopPortal("type convert failed".to_string()))?;
        Ok(match mode_value {
            1 => Mode::Dark,
            2 => Mode::Light,
            _ => Mode::Unspecified,
        })
    })
}

/// Background handle for a Linux/BSD theme watcher.
///
/// The watcher thread blocks on the D-Bus session connection's signal stream, which has
/// no external cancellation mechanism; it is detached rather than joined on drop and will
/// exit the next time it observes that the channel receiver has been dropped.
pub struct WatchGuard(#[allow(dead_code)] Option<JoinHandle<()>>);

pub fn subscribe() -> Result<Watcher, Error> {
    let (sender, receiver) = mpsc::channel();

    let mut changes = zbus::block_on(async {
        let conn = zbus::Connection::session().await?;
        let portal = XdgPortalSettingsProxy::new(&conn, PORTAL_DESTINATION).await?;
        portal.receive_setting_changed().await
    })
    .map_err(|e| Error::XdgDesktopPortal(e.to_string()))?;

    let handle = std::thread::spawn(move || {
        zbus::block_on(async move {
            let mut last = None;
            while let Some(signal) =
                std::future::poll_fn(|cx| std::pin::Pin::new(&mut changes).poll_next(cx)).await
            {
                let Ok(args) = signal.args() else { continue };
                if args.namespace != APPEARANCE || args.key != COLOR_SCHEME {
                    continue;
                }
                let Ok(value): Result<u32, _> = args.value.try_into() else {
                    continue;
                };
                let mode = match value {
                    1 => Mode::Dark,
                    2 => Mode::Light,
                    _ => Mode::Unspecified,
                };
                if Some(mode) == last {
                    continue;
                }
                last = Some(mode);
                if sender.send(mode).is_err() {
                    break;
                }
            }
        })
    });

    Ok(Watcher {
        receiver,
        guard: WatchGuard(Some(handle)),
    })
}
