# Composer IME Evaluation

The composer shell is now canvas-rendered, but the actual text entry layer remains a native textarea.

Why it remains native:

1. Chinese IME composition requires reliable `compositionstart`, `compositionupdate`, and `compositionend` handling.
2. Candidate selection must preserve undo/redo history and not lose the composition range.
3. Paste, multi-line editing, and line-break insertion need browser-native text semantics.

Runtime evaluation harness:

1. The composer canvas now displays IME active/idle state.
2. It counts composition commits, composition updates, paste actions, undo actions, redo actions, and multi-line inserts.
3. It records recent `beforeinput` and composition events to make manual QA visible in the running shell.

Decision for this phase:

1. Do not replace the native textarea yet.
2. Use the canvas shell only as the visual chrome.
3. Revisit full textarea replacement only after on-device IME QA passes for Chinese input, candidate selection, undo, paste, and multi-line editing.

Current validation status:

1. The runtime diagnostics harness is implemented and visible in the running shell.
2. Automated verification can confirm the shell and diagnostics wiring, but it cannot certify real Chinese IME candidate selection behavior.
3. Until a human operator completes on-device Windows IME QA, the native textarea remains the required input layer.