/**
 * The typed RPC contract between the server part and the GUI part.
 *
 * - Server registers it with `ctx.rpc.register` and emits `scene`/`capture`.
 * - GUI calls it through `ctx.client.rpc` and subscribes to its events.
 *
 * The server and the GUI each bundle this module, so they hold two copies of
 * the token. They match by `id` (`mol4agent`), which is the RPC wire key.
 *
 * @module @gcszhn/mol4agent-opencode/rpc
 */
import { Rpc } from '@opencode/plugin/rpc'

export const Mol4Agent = Rpc.define({
  id: 'mol4agent',
  methods: {
    listScenes: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          active: { type: 'string' },
          scenes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sceneId: { type: 'string' },
                path: { type: 'string' },
                label: { type: 'string' },
                format: { type: 'string' },
                binary: { type: 'boolean' },
                revision: { type: 'integer' },
                commands: { type: 'array', items: {} },
              },
              required: ['sceneId', 'path', 'label', 'format', 'binary', 'revision', 'commands'],
              additionalProperties: false,
            },
          },
        },
        required: ['active', 'scenes'],
        additionalProperties: false,
      },
    },
    fetchScene: {
      input: {
        type: 'object',
        properties: { sceneId: { type: 'string' } },
        required: ['sceneId'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          sceneId: { type: 'string' },
          format: { type: 'string' },
          label: { type: 'string' },
          binary: { type: 'boolean' },
          data: { type: 'string' },
        },
        required: ['sceneId', 'format', 'label', 'binary', 'data'],
        additionalProperties: false,
      },
    },
    openPath: {
      input: {
        type: 'object',
        properties: { path: { type: 'string' }, cwd: { type: 'string' }, sessionID: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, path: { type: 'string' }, tab: { type: 'string' }, error: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false,
      },
    },
    deliverCapture: {
      input: {
        type: 'object',
        properties: {
          captureId: { type: 'string' },
          data: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
        required: ['captureId', 'data', 'width', 'height'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, path: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false,
      },
    },
    failCapture: {
      input: {
        type: 'object',
        properties: { captureId: { type: 'string' }, message: { type: 'string' } },
        required: ['captureId', 'message'],
        additionalProperties: false,
      },
      output: { type: 'object', properties: {}, additionalProperties: false },
    },
    pendingCaptures: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          captures: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                captureId: { type: 'string' },
                sceneId: { type: 'string' },
                path: { type: 'string' },
                label: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                transparent: { type: 'boolean' },
              },
              required: ['captureId', 'sceneId', 'path', 'label', 'width', 'height'],
              additionalProperties: false,
            },
          },
        },
        required: ['captures'],
        additionalProperties: false,
      },
    },
  },
  events: {
    scene: {
      schema: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        additionalProperties: false,
      },
    },
    capture: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          captureId: { type: 'string' },
          sceneId: { type: 'string' },
          path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          transparent: { type: 'boolean' },
        },
        required: ['sessionID', 'captureId', 'sceneId', 'path', 'width', 'height'],
        additionalProperties: false,
      },
    },
  },
})
