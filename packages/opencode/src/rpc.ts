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
                structures: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      path: { type: 'string' },
                      label: { type: 'string' },
                      format: { type: 'string' },
                      binary: { type: 'boolean' },
                    },
                    required: ['id', 'path', 'label', 'format', 'binary'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['sceneId', 'path', 'label', 'format', 'binary', 'revision', 'commands', 'structures'],
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
        properties: { sceneId: { type: 'string' }, sessionID: { type: 'string' } },
        required: ['sceneId'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          sceneId: { type: 'string' },
          structureId: { type: 'string' },
          format: { type: 'string' },
          label: { type: 'string' },
          binary: { type: 'boolean' },
          data: { type: 'string' },
        },
        required: ['sceneId', 'format', 'label', 'binary', 'data'],
        additionalProperties: false,
      },
    },
    fetchStructure: {
      input: {
        type: 'object',
        properties: {
          sceneId: { type: 'string' },
          structureId: { type: 'string' },
          sessionID: { type: 'string' },
        },
        required: ['sceneId', 'structureId'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          sceneId: { type: 'string' },
          structureId: { type: 'string' },
          format: { type: 'string' },
          label: { type: 'string' },
          binary: { type: 'boolean' },
          data: { type: 'string' },
        },
        required: ['sceneId', 'structureId', 'format', 'label', 'binary', 'data'],
        additionalProperties: false,
      },
    },
    openPath: {
      input: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          cwd: { type: 'string' },
          base: { type: 'string' },
          sessionID: { type: 'string' },
        },
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
    deliverInspect: {
      input: {
        type: 'object',
        properties: {
          inspectId: { type: 'string' },
          ok: { type: 'boolean' },
          result: { type: 'object' },
          message: { type: 'string' },
        },
        required: ['inspectId', 'ok'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    },
    deliverAlign: {
      input: {
        type: 'object',
        properties: {
          sceneId: { type: 'string' },
          commandIndex: { type: 'integer' },
          ok: { type: 'boolean' },
          result: { type: 'object' },
          message: { type: 'string' },
        },
        required: ['sceneId', 'commandIndex', 'ok'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    },
    deliverTmScore: {
      input: {
        type: 'object',
        properties: {
          tmScoreId: { type: 'string' },
          ok: { type: 'boolean' },
          result: { type: 'object' },
          message: { type: 'string' },
        },
        required: ['tmScoreId', 'ok'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
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
    pendingInspections: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          inspections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                inspectId: { type: 'string' },
                sceneId: { type: 'string' },
                path: { type: 'string' },
                label: { type: 'string' },
                target: { type: 'object' },
                detail: { type: 'string' },
                limit: { type: 'integer' },
              },
              required: ['inspectId', 'sceneId', 'path', 'label'],
              additionalProperties: false,
            },
          },
        },
        required: ['inspections'],
        additionalProperties: false,
      },
    },
    pendingTmScores: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tmScoreId: { type: 'string' },
                sceneId: { type: 'string' },
                path: { type: 'string' },
                label: { type: 'string' },
                reference: { type: 'object' },
                target: { type: 'object' },
              },
              required: ['tmScoreId', 'sceneId', 'path', 'label', 'reference', 'target'],
              additionalProperties: false,
            },
          },
        },
        required: ['queries'],
        additionalProperties: false,
      },
    },
  },
  events: {
    scene: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          path: { type: 'string' },
          open: { type: 'boolean' },
        },
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
    inspect: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          inspectId: { type: 'string' },
          sceneId: { type: 'string' },
          path: { type: 'string' },
          label: { type: 'string' },
          target: { type: 'object' },
          detail: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['sessionID', 'inspectId', 'sceneId', 'path', 'label'],
        additionalProperties: false,
      },
    },
    tmScore: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          tmScoreId: { type: 'string' },
          sceneId: { type: 'string' },
          path: { type: 'string' },
          label: { type: 'string' },
          reference: { type: 'object' },
          target: { type: 'object' },
        },
        required: ['sessionID', 'tmScoreId', 'sceneId', 'path', 'label', 'reference', 'target'],
        additionalProperties: false,
      },
    },
  },
})
