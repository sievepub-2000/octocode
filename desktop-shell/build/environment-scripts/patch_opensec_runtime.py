"""Adapt the pinned OpenSec 3.2.0 distribution to the security-fixed Zod 4 API."""
import json
import hashlib
from pathlib import Path
import sys


def replace(text, before, after, count=1):
    if text.count(before) == count:
        return text.replace(before, after)
    if before not in text and text.count(after) == count:
        return text
    raise ValueError(f"OpenSec source no longer matches reviewed patch: {before[:60]}")


def patch(root):
    base = root / 'node_modules/opensec-intelligence'
    if not base.resolve().is_relative_to(root.resolve()):
        raise ValueError('OpenSec package escaped its runtime root')
    if json.loads((base / 'package.json').read_text(encoding='utf-8'))['version'] != '3.2.0':
        raise ValueError('Unreviewed OpenSec version')
    receipt = root / 'octocode-runtime-patch.json'
    recipe = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if receipt.exists():
        previous = json.loads(receipt.read_text(encoding='utf-8'))
        if previous.get('recipe') == recipe and previous.get('files') and all(
            (root / file).resolve().is_relative_to(base.resolve()) and
            hashlib.sha256((root / file).read_bytes()).hexdigest() == digest
            for file, digest in previous['files'].items()
        ):
            return 0
    changes = {}
    for file, before, after in (
        ('config/schema.js', 'z.record(z.string())', 'z.record(z.string(), z.string())'),
        ('plugins/mcp-client.js', 'z.record(z.unknown())', 'z.record(z.string(), z.unknown())'),
        ('llm/validation/tool-call-schema.js', 'z.record(z.unknown())', 'z.record(z.string(), z.unknown())'),
        ('tools/built-in/web-fetch.js', 'z.record(z.string())', 'z.record(z.string(), z.string())'),
    ):
        path = base / 'dist/src' / file
        changes[path] = replace(path.read_text(encoding='utf-8'), before, after)
    config = base / 'dist/src/config/schema.js'
    # Zod 3's final partial() skipped root defaults; retain that configuration contract.
    for before in (
        ".url().default('http://localhost:11434')", ".string().default('qwen2.5-coder:14b')",
        ".default('ollama')", '.max(16).default(2)', '.max(500).default(30)',
        '.min(1024).default(32768)', 'autoCompact: z.boolean().default(true)',
        'telemetry: z.boolean().default(false)',
        'plugins: z.array(z.string()).default([])',
    ):
        after = before.rsplit('.default(', 1)[0]
        changes[config] = replace(changes[config], before, after)
    changes[config] = replace(changes[config], '}).default({})', '})', 2)
    validation = base / 'dist/src/llm/validation/tool-call-schema.js'
    changes[validation] = replace(changes[validation], 'error.errors', 'error.issues', 2)
    registry = base / 'dist/src/tools/registry.js'
    text = registry.read_text(encoding='utf-8')
    start = text.index('export function zodToJsonSchema(schema) {')
    changes[registry] = "import { z } from 'zod';\n" + text[:start] + """export function zodToJsonSchema(schema) {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
}
"""
    repair = base / 'dist/src/llm/repair/tool-repair.js'
    text = repair.read_text(encoding='utf-8')
    start = text.index('function getZodObjectShape(schema) {')
    changes[repair] = text[:start] + """function getZodObjectShape(schema) {
    try {
        const def = schema?._def;
        if (def?.type === 'object') return schema.shape;
        if (def?.type === 'pipe') return getZodObjectShape(def.in);
    } catch { }
    return null;
}
function getZodBaseType(schema) {
    try {
        const def = schema?._def;
        if (['string', 'number', 'boolean', 'null', 'array'].includes(def?.type)) return def.type;
        if (['optional', 'default', 'nullable'].includes(def?.type)) return getZodBaseType(def.innerType);
    } catch { }
    return null;
}
"""
    checker = base / 'dist/src/cli/update-checker.js'
    if 'export async function checkForUpdate' not in checker.read_text(encoding='utf-8'):
        raise ValueError('Unknown OpenSec update checker')
    changes[checker] = """// Packaged scanner updates are managed by OctoCode.
export async function checkForUpdate(_currentVersion) { return; }
"""
    # Compute every patch before changing the installed distribution.
    for path, text in changes.items():
        if not path.resolve().is_relative_to(base.resolve()):
            raise ValueError('Linked OpenSec source escaped its package')
        text = '\n'.join(line for line in text.splitlines() if not line.startswith('//# sourceMappingURL=')) + '\n'
        path.write_text(text, encoding='utf-8', newline='\n')
    receipt.write_text(json.dumps({'recipe': recipe, 'files': {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in changes
    }}, indent=2), encoding='utf-8')
    return len(changes)


if __name__ == '__main__':
    print(json.dumps({'patchedFiles': patch(Path(sys.argv[1]))}))
