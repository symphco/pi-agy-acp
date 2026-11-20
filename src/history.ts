/**
 * Projection of Pi request history into Antigravity ACP prompts.
 *
 * ACP sessions own their history, so `session/new` appends the MCP
 * tool-routing preamble and Pi's system prompt to agy's system prompt while
 * `<harness_tool_instructions>` and `<pi_history>` travel in a session's
 * opening prompt; subsequent turns send only new input. The replay renders
 * earlier turns as a delimited transcript in front of the newest user input;
 * tool calls keep the agent-visible `mcp_pi_` names.
 * @module pi-agy-acp/history
 */

import type {
  ContentBlock,
  GenerateOptions,
  RequestMessage,
} from './protocol.ts'

/** Server name under which Pi tools reach the agent; the agent prefixes tool names with `mcp_<server>_`. */
export const MCP_SERVER_NAME = 'pi'
/** Agent-visible prefix of every Pi tool. */
export const AGENT_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`
/** Fallback MCP tool name for invoking any Pi tool omitted from direct declarations. */
export const CALL_TOOL_NAME = 'pi_call_tool'

/**
 * Replay budget for `agy`, kept below its `64,000 * 3 = 192,000`
 * byte single-`USER_INPUT` truncation limit so the agent never tail-truncates
 * a replay prompt.
 */
export const REPLAY_BUDGET_BYTES = 160_000

const HISTORY_OPEN = '<pi_history>\n'
const HISTORY_CLOSE = '\n</pi_history>\n\n'
/** Upper bound of the omission notice, reserved before history is selected. */
const OMISSION_NOTICE_RESERVE_BYTES = 128

/**
 * Start of the user message Pi puts first in the context after a compaction
 * (pi-coding-agent `COMPACTION_SUMMARY_PREFIX`).
 */
export const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:'

/**
 * Live input for a rebuild whose trailing messages are all tool results (for
 * example right after compaction in the middle of a tool loop), so the agent
 * receives a meaningful instruction instead of an empty prompt.
 */
export const EMPTY_INPUT_CONTINUATION =
  'Continue the task from the latest tool results above.'

/** One ACP prompt content block. */
export type AcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** System prompt and conversation messages split from one request. */
export interface SplitRequest {
  system: string
  messages: readonly RequestMessage[]
}

/**
 * Split leading system messages (and the one-shot `system` field) from history.
 * @param options - the model request.
 * @returns the combined system text and the remaining messages.
 */
export function splitSystem(options: GenerateOptions): SplitRequest {
  const parts: string[] = []
  if (options.system !== undefined && options.system.length > 0)
    parts.push(options.system)
  let index = 0
  for (const message of options.messages) {
    if (message.role !== 'system') break
    parts.push(textOf(message.content))
    index++
  }
  return {
    system: parts.filter(Boolean).join('\n\n'),
    messages: options.messages.slice(index),
  }
}

/**
 * Join the text blocks of one message.
 * @param content - message content blocks.
 * @returns concatenated text.
 */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter(
      (b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text',
    )
    .map((b) => b.text)
    .join('')
}

/** Compacted initial tool declaration forwarded in the session preamble. */
export interface SupplementalTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Options controlling session preamble rendering and replay budgeting. */
export interface ReplayPromptOptions {
  supplementalTools?: readonly SupplementalTool[]
  maxHistoryBytes?: number
}

/**
 * Static bridge instructions appended to the agent's system prompt.
 * @returns the static bridge preamble.
 */
export function bridgeSystemPrompt(): string {
  return [
    'You are the primary model of a Pi coding agent session. The harness owns the conversation, the tools, and their permissions.',
    `Every harness tool is available to you under the prefix \`${AGENT_TOOL_PREFIX}\`: a tool named \`X\` in the harness instructions is the tool \`${AGENT_TOOL_PREFIX}X\`. If \`${AGENT_TOOL_PREFIX}X\` is absent from your direct tool declarations, invoke it via \`${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME}\` with \`{"name":"X","arguments":{...}}\`. Use only these tools; pass arguments exactly as their schemas define.`,
    'When the first user message contains <harness_tool_instructions> or <pi_history> blocks, treat <harness_tool_instructions> as harness instructions for the entire session and <pi_history> as the earlier part of this conversation; continue from the newest input after them without repeating completed actions.',
  ].join('\n')
}

/**
 * The session's system prompt addition: the bridge instructions, then Pi's
 * own system prompt, so the model receives the harness's role and rules as
 * system instructions rather than as text in the first user message.
 * @param system - the Pi system prompt.
 * @returns text for `systemPrompt.append` of `session/new`.
 */
export function sessionSystemPrompt(system: string): string {
  const bridge = bridgeSystemPrompt()
  return system.length > 0 ? `${bridge}\n\n${system}` : bridge
}

/**
 * Render the full instructions of compacted initial tools for delivery at the
 * head of a session's opening prompt.
 * @param supplementalTools - initially advertised tools whose MCP schemas were compacted, preserving their full instructions.
 * @returns the delimited instruction preamble ending in a blank line, or empty string when absent.
 */
export function renderSessionInstructions(
  supplementalTools: readonly SupplementalTool[] = [],
): string {
  if (supplementalTools.length === 0) return ''
  const entries = supplementalTools.map((t) =>
    JSON.stringify({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }),
  )
  return `<harness_tool_instructions>\n${entries.join('\n')}\n</harness_tool_instructions>\n\n`
}

/**
 * Render a list of messages as transcript text.
 * @param messages - earlier conversation messages.
 * @returns transcript lines.
 */
export function renderTranscript(messages: readonly RequestMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        lines.push(`<user>\n${renderBlocks(message.content)}\n</user>`)
        break
      case 'assistant': {
        const text = renderBlocks(
          message.content.filter(
            (b) => b.type !== 'tool-call' && b.type !== 'reasoning',
          ),
        )
        if (text.length > 0) lines.push(`<assistant>\n${text}\n</assistant>`)
        for (const block of message.content) {
          if (block.type === 'tool-call') {
            lines.push(
              `<tool_call id="${block.id}" name="${AGENT_TOOL_PREFIX}${block.name}">\n${block.arguments}\n</tool_call>`,
            )
          }
        }
        break
      }
      case 'tool':
        lines.push(
          `<tool_result id="${message.toolCallId}"${message.isError === true ? ' error="true"' : ''}>\n${renderBlocks(message.content)}\n</tool_result>`,
        )
        break
      case 'system':
        lines.push(
          `<system_update>\n${renderBlocks(message.content)}\n</system_update>`,
        )
        break
      default:
        break
    }
  }
  return lines.join('\n\n')
}

function renderBlocks(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'image':
        parts.push('[image]')
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/**
 * Convert one user-role message into ACP prompt blocks.
 * @param content - user content blocks.
 * @returns prompt blocks in content order.
 */
export function promptBlocks(
  content: readonly ContentBlock[],
): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.length > 0) blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType })
    } else {
      const text = renderBlocks([block])
      if (text.length > 0) blocks.push({ type: 'text', text })
    }
  }
  return blocks
}

/**
 * Build the prompt that (re)creates a session: harness tool instructions,
 * earlier history as transcript, and trailing input messages as live content.
 *
 * The trailing input and session instructions are always complete. History
 * renders newest-first into the remaining byte budget, so the most recent turns
 * survive and only the oldest messages are omitted; an omitted prefix is
 * announced inside the block. The `<pi_history>` block is always closed before
 * the live input. When the plan leaves no trailing input (the history ends with
 * tool results), a short continuation instruction is appended so the prompt is
 * never empty.
 * @param history - messages before the trailing input.
 * @param input - trailing input messages sent as live content.
 * @param options - session instructions and replay byte ceiling; defaults to {@link REPLAY_BUDGET_BYTES}.
 * @returns prompt blocks.
 */
export function replayPrompt(
  history: readonly RequestMessage[],
  input: readonly RequestMessage[],
  options: ReplayPromptOptions = {},
): AcpPromptBlock[] {
  const preamble = renderSessionInstructions(options.supplementalTools ?? [])
  const inputBlocks: AcpPromptBlock[] =
    input.length > 0
      ? inputPrompt(input)
      : [{ type: 'text', text: EMPTY_INPUT_CONTINUATION }]
  const blocks: AcpPromptBlock[] = []
  if (preamble.length > 0) blocks.push({ type: 'text', text: preamble })
  if (history.length > 0) {
    const maxBytes = options.maxHistoryBytes ?? REPLAY_BUDGET_BYTES
    const preambleBytes = utf8Bytes(preamble)
    const inputBytes = inputBlocks.reduce(
      (total, block) =>
        total + (block.type === 'text' ? utf8Bytes(block.text) : 0),
      0,
    )
    const overhead =
      utf8Bytes(HISTORY_OPEN) +
      utf8Bytes(HISTORY_CLOSE) +
      OMISSION_NOTICE_RESERVE_BYTES
    const text = historyTranscript(
      history,
      Math.max(0, maxBytes - preambleBytes - inputBytes - overhead),
    )
    if (text.length > 0) blocks.push({ type: 'text', text })
  }
  blocks.push(...inputBlocks)
  return blocks
}

/**
 * Render the newest messages that fit `budget`, announcing any omitted prefix.
 * @param history - messages before the trailing input.
 * @param budget - byte budget for the transcript body.
 * @returns the complete `<pi_history>` block, or an empty string without history.
 */
function historyTranscript(
  history: readonly RequestMessage[],
  budget: number,
): string {
  // Pi's compaction summary (goal, constraints, decisions) is the oldest
  // message after a compaction; keep it whenever it fits, then fill newest first.
  const first = history[0]
  const summary =
    first?.role === 'user' &&
    textOf(first.content).startsWith(COMPACTION_SUMMARY_PREFIX)
      ? renderTranscript([first])
      : undefined
  const kept =
    summary !== undefined && utf8Bytes(summary) + 2 <= budget
      ? summary
      : undefined
  const lowest = kept === undefined ? 0 : 1
  const parts: string[] = []
  let used = kept === undefined ? 0 : utf8Bytes(kept) + 2
  let dropped = 0
  for (let index = history.length - 1; index >= lowest; index--) {
    const message = history[index] as RequestMessage
    const rendered = renderTranscript([message])
    const separator = parts.length === 0 ? 0 : 2
    const bytes = utf8Bytes(rendered)
    if (used + separator + bytes > budget) {
      if (parts.length === 0 && message.role === 'tool' && budget > 1024) {
        const truncated = truncatedToolTranscript(message, budget)
        if (truncated !== undefined) {
          parts.unshift(truncated)
          dropped = index - lowest
        } else {
          dropped = index + 1 - lowest
        }
      } else {
        dropped = index + 1 - lowest
      }
      break
    }
    parts.unshift(rendered)
    used += separator + bytes
  }
  if (dropped > 0)
    parts.unshift(
      `[Earlier ${dropped} history messages omitted to fit the context replay budget]`,
    )
  if (kept !== undefined) parts.unshift(kept)
  if (parts.length === 0) return ''
  return `${HISTORY_OPEN}${parts.join('\n\n')}${HISTORY_CLOSE}`
}

/**
 * Render one oversized tool result with its head kept inside `budget`.
 * @param message - the newest tool message.
 * @param budget - byte budget for its rendered transcript.
 * @returns the truncated transcript, or undefined when even the markup does not fit.
 */
function truncatedToolTranscript(
  message: Extract<RequestMessage, { role: 'tool' }>,
  budget: number,
): string | undefined {
  const marker = '\n[tool result truncated to fit the context replay budget]'
  let limit = budget - utf8Bytes(marker)
  for (let attempt = 0; attempt < 8 && limit > 0; attempt++) {
    const content: ContentBlock[] = [
      {
        type: 'text',
        text: `${headWithinBytes(renderBlocks(message.content), limit)}${marker}`,
      },
    ]
    const rendered = renderTranscript([{ ...message, content }])
    const bytes = utf8Bytes(rendered)
    if (bytes <= budget) return rendered
    limit -= bytes - budget
  }
  return undefined
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function headWithinBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end--
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * Convert new input messages (user and system notices) into live prompt blocks.
 * @param input - messages that arrived after the session's known history.
 * @returns prompt blocks.
 */
export function inputPrompt(
  input: readonly RequestMessage[],
): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = []
  for (const message of input) {
    if (message.role === 'user') blocks.push(...promptBlocks(message.content))
    else {
      const text = renderTranscript([message])
      if (text.length > 0) blocks.push({ type: 'text', text })
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: 'Continue.' })
  return blocks
}
