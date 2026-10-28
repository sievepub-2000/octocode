/* Public test entry: no BrowserWindow; the caller supplies an isolated user-data directory. */
const { app } = require('electron');
const crypto = require('node:crypto');
app.disableHardwareAcceleration();
app.whenReady().then(() => {
	console.log('OWNED_RANDOM_SNAPSHOT:' + JSON.stringify({
		pid: process.pid,
		electron: process.versions.electron,
		node: process.versions.node,
		permission: !!process.permission,
		execArgv: process.execArgv,
		uuid: Array.from({ length: 256 }, () => crypto.randomUUID()),
		integers: Array.from({ length: 2048 }, () => crypto.randomInt(2 ** 48 - 1))
	}));
	app.quit();
});
