import base64
import copy
import importlib.metadata
from pathlib import Path
import unittest
import asyncio
import io
from unittest.mock import patch

import jwt
import httpx
from google.protobuf import json_format, struct_pb2
from mcp.server.lowlevel.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.types import LATEST_PROTOCOL_VERSION


class RuntimePythonSecurityTests(unittest.TestCase):
    def test_hash_pinned_runtime_versions(self):
        pins = Path(__file__).with_name('runtime-python-requirements.txt').read_text().splitlines()
        actual = []
        for line in pins:
            if not line or line.startswith('#'):
                continue
            requirement, digest = line.split(' --hash=sha256:')
            name, version = requirement.split('==')
            self.assertEqual(len(digest), 64)
            self.assertEqual(importlib.metadata.version(name), version)
            copies = [distribution for distribution in importlib.metadata.distributions()
                      if distribution.metadata.get('Name', '').lower().replace('_', '-') == name.lower().replace('_', '-')]
            self.assertEqual(len(copies), 1, f'Duplicate distribution metadata for {name}')
            actual.append(name.lower())
        self.assertCountEqual(actual, ['protobuf', 'pyjwt', 'tornado', 'urllib3', 'mcp', 'brotli', 'certifi',
                                      'fastmcp', 'fastmcp-slim', 'nbconvert', 'opentelemetry-api', 'pillow', 'pip'])

    def test_brotli_roundtrip(self):
        import brotli
        payload = bytes(range(256)) * 128
        self.assertEqual(brotli.decompress(brotli.compress(payload)), payload)

    def test_pillow_basic_formats(self):
        from PIL import Image
        image = Image.new('RGB', (12, 8), (80, 40, 20))
        for format in ('PNG', 'JPEG', 'WEBP', 'GIF'):
            with self.subTest(format=format):
                stream = io.BytesIO()
                image.save(stream, format=format)
                stream.seek(0)
                with Image.open(stream) as decoded:
                    decoded.load()
                    self.assertEqual(decoded.size, image.size)
                    if format == 'PNG':
                        self.assertEqual(decoded.tobytes(), image.tobytes())

    def test_jwt_valid_signature_and_wrong_key(self):
        token = jwt.encode({'sub': 'acceptance-fixture'}, 'fixture-signing-key-32-bytes-long!', algorithm='HS256')
        self.assertEqual(jwt.decode(token, 'fixture-signing-key-32-bytes-long!', algorithms=['HS256'])['sub'], 'acceptance-fixture')
        with self.assertRaises(jwt.InvalidSignatureError):
            jwt.decode(token, 'wrong-fixture-signing-key-32bytes', algorithms=['HS256'])

    def test_jwt_does_not_mutate_verification_options(self):
        token = jwt.encode({'sub': 'acceptance-fixture'}, 'fixture-signing-key-32-bytes-long!', algorithm='HS256')
        options = {'verify_signature': False}
        before = copy.deepcopy(options)
        jwt.decode(token, options=options)
        self.assertEqual(options, before)

    def test_empty_jwk_hmac_key_is_rejected(self):
        with self.assertRaises(jwt.PyJWTError):
            jwt.PyJWK.from_dict({'kty': 'oct', 'k': ''})

    def test_deep_jwt_header_is_catchable(self):
        header = b'{"alg":"HS256","nested":' + b'[' * 2000 + b'0' + b']' * 2000 + b'}'
        segment = base64.urlsafe_b64encode(header).rstrip(b'=')
        token = segment.decode() + '.e30.AAAA'
        with self.assertRaises(jwt.PyJWTError):
            jwt.decode(token, 'fixture-signing-key-32-bytes-long!', algorithms=['HS256'])
        # Python 3.14 parses deeply nested JSON iteratively; exercise the older-parser failure too.
        with patch('jwt.api_jws.json.loads', side_effect=RecursionError('fixture recursion limit')):
            with self.assertRaises(jwt.DecodeError):
                jwt.get_unverified_header(token)

    def test_protobuf_json_depth_limit(self):
        payload = '{"nested":' * 200 + 'null' + '}' * 200
        with self.assertRaises(json_format.ParseError):
            json_format.Parse(payload, struct_pb2.Struct(), max_recursion_depth=20)


class McpSessionSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_session_limit_delete_cleanup_and_idle_expiry(self):
        manager = StreamableHTTPSessionManager(Server('octocode-security-fixture'), json_response=True,
                                              max_sessions=1, session_idle_timeout=0.2)
        headers = {'Accept': 'application/json, text/event-stream'}
        initialize = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': LATEST_PROTOCOL_VERSION, 'capabilities': {},
            'clientInfo': {'name': 'octocode-security-fixture', 'version': '1.0'}}}
        async with manager.run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=manager.handle_request),
                                        base_url='http://localhost', headers=headers) as client:
                first = await client.post('/mcp', json=initialize)
                self.assertEqual(first.status_code, 200, first.text)
                session = first.headers['mcp-session-id']
                with self.assertLogs('mcp.server.streamable_http_manager', level='WARNING') as logs:
                    refused = await client.post('/mcp', json=initialize)
                self.assertEqual(refused.status_code, 503)
                self.assertTrue(any('Refusing to open a new session' in line for line in logs.output))
                session_headers = {'mcp-session-id': session, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION}
                deleted = await client.delete('/mcp', headers=session_headers)
                self.assertEqual(deleted.status_code, 200, deleted.text)
                self.assertEqual((await client.get('/mcp', headers=session_headers)).status_code, 404)
                replacement = await client.post('/mcp', json=initialize)
                self.assertEqual(replacement.status_code, 200, replacement.text)
                session_headers['mcp-session-id'] = replacement.headers['mcp-session-id']
                await asyncio.sleep(0.4)
                self.assertEqual((await client.get('/mcp', headers=session_headers)).status_code, 404)


if __name__ == '__main__':
    unittest.main()
