/* Test-only bridge to Electron's exported upstream SPKI regression-test hooks. */
#include <windows.h>
#include <node_api.h>

static napi_value add(napi_env env, napi_callback_info info) {
	size_t argc = 1, length = 0;
	napi_value value, result;
	void* bytes = NULL;
	if (napi_get_cb_info(env, info, &argc, &value, NULL, NULL) != napi_ok || argc != 1 ||
		napi_get_buffer_info(env, value, &bytes, &length) != napi_ok || length != 32) {
		napi_throw_type_error(env, NULL, "Expected a SHA-256 Buffer");
		return NULL;
	}
	typedef void (*add_fn)(const unsigned char*);
	add_fn hook = (add_fn)GetProcAddress(GetModuleHandleW(NULL), "?AddBlockedSPKIForTesting@crypto@node@@YAXPEBE@Z");
	if (!hook) {
		napi_throw_error(env, NULL, "Electron SPKI test hook is unavailable");
		return NULL;
	}
	hook((const unsigned char*)bytes);
	napi_get_undefined(env, &result);
	return result;
}

static napi_value clear(napi_env env, napi_callback_info info) {
	(void)info;
	typedef void (*clear_fn)(void);
	clear_fn hook = (clear_fn)GetProcAddress(GetModuleHandleW(NULL), "?ClearBlockedSPKIsForTesting@crypto@node@@YAXXZ");
	if (!hook) {
		napi_throw_error(env, NULL, "Electron SPKI test hook is unavailable");
		return NULL;
	}
	hook();
	napi_value result;
	napi_get_undefined(env, &result);
	return result;
}

static napi_value init(napi_env env, napi_value exports) {
	const napi_property_descriptor methods[] = {
		{ "add", NULL, add, NULL, NULL, NULL, napi_default, NULL },
		{ "clear", NULL, clear, NULL, NULL, NULL, napi_default, NULL }
	};
	if (napi_define_properties(env, exports, 2, methods) != napi_ok) return NULL;
	return exports;
}

NAPI_MODULE(spki_test, init)
