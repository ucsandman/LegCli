import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLines } from '../src/taps/codex.mjs'

const toolCall = (input) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'custom_tool_call', input },
})

const functionCall = (args) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'function_call', arguments: args },
})

test('codex patch paths: direct patch input records its file', () => {
  const result = parseLines([toolCall('*** Begin Patch\n*** Update File: src/taps/codex.mjs\n*** End Patch')])
  assert.deepEqual(result.files, ['src/taps/codex.mjs'])
})

test('codex patch paths: function arguments preserve direct patch files', () => {
  const result = parseLines([functionCall('*** Begin Patch\n*** Delete File: test/obsolete.test.mjs\n*** End Patch')])
  assert.deepEqual(result.files, ['test/obsolete.test.mjs'])
})

test('codex patch paths: direct Windows paths retain backslashes', () => {
  const input = ['*** Begin Patch', '*** Update File: C:\\new\\notes.txt', '*** End Patch'].join('\n')
  const result = parseLines([toolCall(input)])
  assert.deepEqual(result.files, ['C:\\new\\notes.txt'])
})

test('codex patch paths: direct patches ignore nested apply_patch source', () => {
  const input = [
    '*** Begin Patch',
    '*** Add File: src/outer.mjs',
    String.raw`+const nested = "tools.apply_patch('*** Begin Patch\n*** Add File: src/inner.mjs\n*** End Patch')"`,
    '*** End Patch',
  ].join('\n')
  const result = parseLines([toolCall(input)])
  assert.deepEqual(result.files, ['src/outer.mjs'])
})

test('codex patch paths: escaped functions.exec patch extracts only its file', () => {
  const input = String.raw`await tools.apply_patch('*** Begin Patch\n*** Add File: test/marker.test.mjs\n+const address = server.address()\n+const stop = () => close()\n*** End Patch')`
  const result = parseLines([toolCall(input)])
  assert.deepEqual(result.files, ['test/marker.test.mjs'])
})

test('codex patch paths: escaped wrappers decode Windows paths atomically', () => {
  const input = String.raw`await tools.apply_patch('*** Begin Patch\n*** Add File: C:\\new\\notes.txt\n+export const marker = true\n*** End Patch')`
  const result = parseLines([toolCall(input)])
  assert.deepEqual(result.files, ['C:\\new\\notes.txt'])
})

test('codex patch paths: an incomplete wrapper records no source as a path', () => {
  const input = String.raw`await tools.apply_patch('*** Begin Patch\n*** Add File: test/marker.test.mjs\n+const server = start()')`
  const result = parseLines([toolCall(input)])
  assert.deepEqual(result.files, [])
})
