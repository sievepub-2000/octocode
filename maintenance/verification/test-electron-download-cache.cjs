const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const source = path.resolve(__dirname, '../..');
const checksumFile = path.join(source, 'desktop-shell/build/checksums/electron.txt');
const sums = fs.readFileSync(checksumFile, 'utf8');
const match = sums.match(/^([a-f0-9]{64}) \*electron-v([\d.]+)-win32-x64\.zip$/m);
assert(match, 'Expected a pinned Windows Electron checksum');
const fixture = path.resolve(fs.mkdtempSync('E:/Program Files/octocode/test/electron-cache-'));
process.env.TEMP = process.env.TMP = fixture;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw Error('Network forbidden in cached Electron regression'); };
const { download } = require(path.join(source, 'desktop-shell/vendor/gulp-electron/src/download.js'));
const options = { version: match[2], platform: 'win32', arch: 'x64', artifactName: 'electron', validateChecksum: true, checksumFile };
(async () => {
    try {
        const file = await download(options);
        assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), match[1]);
        const invalid = path.join(fixture, 'invalid.txt');
        for (const text of ['', 'invalid checksum', `${match[0]}\n${match[0]}`]) {
            fs.writeFileSync(invalid, text);
            await assert.rejects(download({ ...options, checksumFile: invalid }), /checksum/i);
        }
        assert.equal(networkCalls, 0);
        console.log(JSON.stringify({ status: 'PASS', cachedArtifactSha256: match[1], networkCalls, malformedInputsRejected: 3 }));
    } finally {
        assert.equal(path.dirname(fixture), path.resolve('E:/Program Files/octocode/test'));
        fs.rmSync(fixture, { recursive: true });
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
