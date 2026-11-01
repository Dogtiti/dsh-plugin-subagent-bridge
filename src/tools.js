import { MAX_WAIT_SECONDS } from './constants.js'

export const TOOLS = [
  {
    name: 'dsh_task',
    description:
      'Delegate one self-contained task to DeepSeek Harness and wait for the finished answer, exactly like spawning a subagent: the bridge opens a fresh DSH session in `cwd`, delivers the task, blocks up to 240 seconds, and returns the answer. A result with status "timeout" and running:true means the worker is STILL WORKING: keep the turn open and call dsh_wait or dsh_task again until it is no longer running. Never pass a timeout above 240 seconds — the MCP client aborts tool calls after 300. The prompt is delivered verbatim as an ordinary user message in that session, so write it as a work order for a colleague: do not mention your own tools, skills, or role framing — the worker has no such skill and will only waste a turn looking for it.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Self-contained task for the DSH worker, including acceptance criteria.' },
        cwd: { type: 'string', description: 'Working directory the worker runs in. Defaults to the DSH default directory.' },
        sessionId: {
          type: 'string',
          description: 'Continue an existing idle session (multi-turn worker) instead of opening a new one.',
        },
        agentPreset: { type: 'string', description: 'Agent preset for a new session.' },
        model: {
          type: 'string',
          description:
            'Model to run this worker on, as "provider/model" (for example "zai-coding-cn/glm-5.3"). A bare model id keeps the current default provider. Omit to use whatever the session already uses.',
        },
        workspace: {
          type: ['boolean', 'string'],
          description:
            'Grouping for the new session. true creates a DSH project (workspace) for `cwd`, titled after its last path segment, when none owns that directory yet; a string uses that title instead. Omit (or false) to only reuse an existing project, leaving the session ungrouped when the directory has none.',
        },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description:
            'How a busy session receives this: "queue" (default) waits for the running turn to finish, "steer" inserts the message into that turn so the model sees it at the next step.',
        },

        reasoningEffort: {
          type: 'string',
          description: 'Reasoning level for `model`, if that model offers levels (low, medium, high, max...).',
        },
        timeoutSeconds: { type: 'number', description: 'How long to wait for the turn to finish. Default 300, max 600.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_spawn',
    description:
      'Start a worker and return immediately with its task_name, so several workers can run in parallel. This tool does NOT wait and the result is never pushed back, so you must collect it in this same turn with dsh_wait (each call blocks up to 240 seconds; repeat until every target is no longer "running") before you end the turn. Use fork_turns "all" with `from` to start the worker from a copy of an existing DSH session.',
    inputSchema: {
      type: 'object',
      properties: {
        task_name: { type: 'string', description: 'Lowercase letters, digits, and underscores.' },
        message: { type: 'string', description: 'Self-contained work order for the worker.' },
        fork_turns: {
          type: 'string',
          enum: ['none', 'all'],
          description: 'none starts empty (default); all forks the session named by `from`.',
        },
        from: { type: 'string', description: 'Session id to fork when fork_turns is "all".' },
        cwd: { type: 'string', description: 'Working directory for a fresh worker.' },
        model: {
          type: 'string',
          description:
            'Model for this worker, as "provider/model" (for example "opencode-go/deepseek-v4.1-flash"). A bare model id keeps the current default provider.',
        },
        workspace: {
          type: ['boolean', 'string'],
          description:
            'Grouping for the new worker. true creates a DSH project (workspace) for `cwd` when none owns it; a string uses that title. Omit to only reuse an existing project.',
        },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description:
            'How a busy session receives this: "queue" (default) waits for the running turn to finish, "steer" inserts the message into that turn so the model sees it at the next step.',
        },

        reasoningEffort: { type: 'string', description: 'Reasoning level for `model`, when that model offers levels.' },
      },
      required: ['task_name', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_followup',
    description:
      'Give an existing worker another task and trigger a turn. The worker keeps its own conversation, so this is cheaper than spawning a new one.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: 'task_name from dsh_spawn, or a session id.' },
        message: { type: 'string', description: 'Follow-up work order.' },
        model: {
          type: 'string',
          description: 'Switch this worker to another model before the turn, as "provider/model". Omit to keep its current one.',
        },
        reasoningEffort: { type: 'string', description: 'Reasoning level for `model`, when that model offers levels.' },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description:
            'How a busy session receives this: "queue" (default) waits for the running turn to finish, "steer" inserts the message into that turn so the model sees it at the next step.',
        },
      },
      required: ['worker', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_close',
    description:
      'Close a worker and free its concurrency slot. Finished workers still count against the limit until closed. Closing does not delete the session.',
    inputSchema: {
      type: 'object',
      properties: { worker: { type: 'string', description: 'task_name or session id.' } },
      required: ['worker'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_answer',
    description:
      'Answer a question a worker is blocked on (ask_user_question) on the user behalf. dsh_wait reports such a question as pendingQuestion; every question id in it must appear exactly once in answers.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: 'task_name or session id of the blocked worker.' },
        answers: {
          type: 'array',
          description: 'One entry per pending question.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Question id, copied from pendingQuestion.' },
              selected: {
                type: 'array',
                items: { type: 'string' },
                description: 'Chosen option labels; empty when the question is being skipped.',
              },
              custom: { type: 'string', description: 'Free-form answer when no option fits.' },
            },
            required: ['id', 'selected'],
            additionalProperties: false,
          },
        },
      },
      required: ['worker', 'answers'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_workers',
    description: 'List the workers this bridge started, with their task_name, session id, and live status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'dsh_dispatch',
    description:
      'Deliver one message into a DeepSeek Harness session as the user and start a turn. Returns the request id and the session event sequence at dispatch time; pass that sequence to dsh_read_result to collect the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target DSH session id, from dsh_list_sessions.' },
        text: { type: 'string', description: 'Message text to deliver.' },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: 'queue delivers as the next user turn; steer adds it to a running turn. Defaults to queue.',
        },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_wait',
    description:
      'Wait until any of the given workers reaches a final state, then return per-worker status. A finished worker carries its final answer only. Long waits beat polling: pass timeoutMs: 240000, and when the reply still lists "running" workers, call this again instead of ending the turn.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Session ids returned by dsh_task or dsh_dispatch.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Wait timeout in milliseconds. Default 30000, min 1000, max 3600000.',
        },
      },
      required: ['targets'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_read_result',
    description:
      'Long-poll one session for assistant text produced after the given event sequence. Returns as soon as text appears, when the turn ends, or when the wait expires. Only sessions this bridge dispatched to are readable.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id returned by dsh_dispatch.' },
        sinceSeq: { type: 'number', description: 'The seqAtDispatch value returned by dsh_dispatch.' },
        waitSeconds: {
          type: 'number',
          description: `How long to wait for the answer, at most ${MAX_WAIT_SECONDS}. Defaults to the plugin config.`,
        },
      },
      required: ['sessionId', 'sinceSeq'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_sessions',
    description:
      'List DeepSeek Harness sessions with metadata only: id, title, working directory, running state, and last activity. Never returns message content.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/**
 * Standing instruction appended to a delegated task.
 *
 * A worker that stops to ask a question needs somebody at the UI; when the caller is
 * another agent, nobody is. The caller would rather have a reasonable assumption and a
 * finished result, so the worker is told to make one and report it.
 */
