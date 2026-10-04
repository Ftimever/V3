export const pluginManifestSchema: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:easybot:schema:plugin-manifest:v1",
  "title": "Plugin Manifest",
  "type": "object",
  "required": [
    "schemaVersion",
    "pluginId",
    "displayName",
    "runtime"
  ],
  "additionalProperties": false,
  "properties": {
    "$schema": {
      "type": "string"
    },
    "schemaVersion": {
      "const": 1
    },
    "pluginId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)+$"
    },
    "displayName": {
      "type": "string",
      "minLength": 1
    },
    "description": {
      "type": "string"
    },
    "documentation": {
      "type": "string"
    },
    "runtime": {
      "type": "object",
      "required": [
        "kind",
        "entry"
      ],
      "additionalProperties": false,
      "properties": {
        "kind": {
          "enum": [
            "in-process",
            "child-process"
          ]
        },
        "entry": {
          "type": "string",
          "pattern": "^\\./",
          "minLength": 3
        },
        "protocolVersion": {
          "type": "integer",
          "minimum": 1
        }
      }
    },
    "provides": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "services": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        },
        "events": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/eventReference"
          }
        }
      }
    },
    "requires": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "plugins": {
          "$ref": "#/$defs/pluginDependencies"
        },
        "services": {
          "$ref": "#/$defs/serviceDependencies"
        },
        "capabilities": {
          "$ref": "#/$defs/capabilityDependencies"
        }
      }
    },
    "permissions": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/permission"
      }
    },
    "lifecycle": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "restart": {
          "type": "object",
          "required": [
            "enabled"
          ],
          "additionalProperties": false,
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "maxAttempts": {
              "type": "integer",
              "minimum": 0
            },
            "backoff": {
              "enum": [
                "fixed",
                "linear",
                "exponential"
              ]
            },
            "delayMs": {
              "type": "integer",
              "minimum": 0
            },
            "maxDelayMs": {
              "type": "integer",
              "minimum": 0
            }
          }
        },
        "requiredDependencyFailure": {
          "const": "stop"
        },
        "optionalDependencyFailure": {
          "enum": [
            "stop",
            "degraded"
          ]
        }
      }
    },
    "config": {
      "$ref": "#/$defs/config"
    },
    "webui": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "navigation": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "route"
            ],
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              },
              "label": {
                "type": "string",
                "minLength": 1
              },
              "route": {
                "type": "string",
                "pattern": "^/"
              },
              "icon": {
                "type": "string"
              }
            }
          }
        },
        "config": {
          "$ref": "#/$defs/config"
        },
        "cards": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "id",
              "component"
            ],
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              },
              "component": {
                "enum": [
                  "status-card",
                  "log-panel",
                  "info-card"
                ]
              },
              "title": {
                "type": "string"
              },
              "props": {
                "$ref": "#/$defs/jsonObject"
              }
            }
          }
        }
      }
    }
  },
  "$defs": {
    "eventReference": {
      "type": "object",
      "required": [
        "id",
        "version"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"
        },
        "delivery": {
          "enum": [
            "parallel",
            "serial",
            "pipeline"
          ]
        },
        "retryable": {
          "type": "boolean"
        }
      }
    },
    "reference": {
      "type": "object",
      "required": [
        "id",
        "version"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "methods": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "type": "string",
            "pattern": "^[a-zA-Z][a-zA-Z0-9_]*$",
            "not": {
              "enum": [
                "constructor",
                "prototype",
                "then"
              ]
            }
          }
        },
        "version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"
        }
      }
    },
    "pluginDependency": {
      "type": "object",
      "required": [
        "pluginId",
        "version"
      ],
      "additionalProperties": false,
      "properties": {
        "pluginId": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "serviceDependency": {
      "type": "object",
      "required": [
        "id",
        "version"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "capabilityDependency": {
      "type": "object",
      "required": [
        "id"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "pluginDependencies": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "required": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/pluginDependency"
          }
        },
        "optional": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/pluginDependency"
          }
        }
      }
    },
    "serviceDependencies": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "required": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/serviceDependency"
          }
        },
        "optional": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/serviceDependency"
          }
        }
      }
    },
    "capabilityDependencies": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "required": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/capabilityDependency"
          }
        },
        "optional": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/capabilityDependency"
          }
        }
      }
    },
    "permission": {
      "type": "object",
      "required": [
        "id"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^(process|network|filesystem|storage|service|event|webui|secret):.+$"
        },
        "reason": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/jsonObject"
        }
      }
    },
    "config": {
      "type": "object",
      "required": [
        "schema"
      ],
      "additionalProperties": false,
      "properties": {
        "schema": {
          "type": "string",
          "minLength": 1
        },
        "properties": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "x-reload": {
                "enum": [
                  "hot",
                  "reconnect",
                  "restart",
                  "manual"
                ]
              }
            }
          }
        }
      }
    },
    "json": {
      "anyOf": [
        {
          "type": [
            "string",
            "number",
            "boolean",
            "null"
          ]
        },
        {
          "type": "array",
          "items": {
            "$ref": "#/$defs/json"
          }
        },
        {
          "$ref": "#/$defs/jsonObject"
        }
      ]
    },
    "jsonObject": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/json"
      }
    }
  }
}

export const pluginGroupManifestSchema: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:easybot:schema:plugin-group:v1",
  "title": "Plugin Group Manifest",
  "type": "object",
  "required": [
    "schemaVersion",
    "groupId",
    "displayName",
    "version",
    "members"
  ],
  "additionalProperties": false,
  "properties": {
    "$schema": {
      "type": "string"
    },
    "schemaVersion": {
      "const": 1
    },
    "groupId": {
      "type": "string",
      "minLength": 1
    },
    "displayName": {
      "type": "string",
      "minLength": 1
    },
    "version": {
      "type": "string",
      "minLength": 1
    },
    "members": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "pluginId",
          "packageName",
          "version",
          "instanceId"
        ],
        "additionalProperties": false,
        "properties": {
          "pluginId": {
            "type": "string",
            "minLength": 1
          },
          "packageName": {
            "type": "string",
            "minLength": 1
          },
          "version": {
            "type": "string",
            "minLength": 1
          },
          "instanceId": {
            "type": "string",
            "minLength": 1
          },
          "runtime": {
            "type": "object",
            "required": [
              "kind",
              "entry",
              "trust"
            ],
            "additionalProperties": false,
            "properties": {
              "kind": {
                "enum": [
                  "in-process",
                  "child-process"
                ]
              },
              "entry": {
                "type": "string",
                "pattern": "^\\./"
              },
              "protocolVersion": {
                "type": "integer",
                "minimum": 1
              },
              "trust": {
                "enum": [
                  "trusted",
                  "isolated",
                  "privileged"
                ]
              }
            }
          }
        }
      }
    },
    "serviceBindings": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": [
          "implementation"
        ],
        "additionalProperties": false,
        "properties": {
          "implementation": {
            "type": "string",
            "minLength": 1
          },
          "allowOverride": {
            "type": "boolean"
          }
        }
      }
    },
    "permissions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "instanceId",
          "id"
        ],
        "additionalProperties": false,
        "properties": {
          "instanceId": {
            "type": "string",
            "minLength": 1
          },
          "id": {
            "type": "string",
            "pattern": "^(process|network|filesystem|storage|service|event|webui|secret):.+$"
          },
          "scope": {
            "$ref": "#/$defs/jsonObject"
          }
        }
      }
    }
  },
  "$defs": {
    "json": {
      "anyOf": [
        {
          "type": [
            "string",
            "number",
            "boolean",
            "null"
          ]
        },
        {
          "type": "array",
          "items": {
            "$ref": "#/$defs/json"
          }
        },
        {
          "$ref": "#/$defs/jsonObject"
        }
      ]
    },
    "jsonObject": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/json"
      }
    }
  }
}

export const rpcEnvelopeSchema: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:easybot:schema:rpc-envelope:v1",
  "title": "RPC Envelope",
  "type": "object",
  "required": [
    "protocol",
    "version",
    "type"
  ],
  "additionalProperties": false,
  "properties": {
    "protocol": {
      "const": "easybot.rpc"
    },
    "version": {
      "const": 1
    },
    "type": {
      "enum": [
        "request",
        "response",
        "notification",
        "stream",
        "cancel",
        "hello",
        "hello-ack"
      ]
    },
    "pluginInstanceId": {
      "type": "string",
      "minLength": 1
    },
    "traceId": {
      "type": "string",
      "minLength": 1
    },
    "deadline": {
      "type": "number",
      "minimum": 0
    },
    "capability": {
      "type": "string",
      "minLength": 1
    },
    "id": {
      "type": "string",
      "minLength": 1
    },
    "method": {
      "type": "string",
      "minLength": 1
    },
    "payload": {
      "$ref": "#/$defs/json"
    },
    "ok": {
      "type": "boolean"
    },
    "error": {
      "$ref": "#/$defs/error"
    },
    "reason": {
      "type": "string"
    },
    "stream": {
      "enum": [
        "open",
        "chunk",
        "close"
      ]
    },
    "capabilities": {
      "$ref": "#/$defs/capabilities"
    }
  },
  "oneOf": [
    {
      "properties": {
        "type": {
          "const": "request"
        }
      },
      "required": [
        "id",
        "method"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "ok"
            ]
          },
          {
            "required": [
              "error"
            ]
          },
          {
            "required": [
              "stream"
            ]
          },
          {
            "required": [
              "capabilities"
            ]
          }
        ]
      }
    },
    {
      "properties": {
        "type": {
          "const": "response"
        },
        "ok": {
          "const": true
        }
      },
      "required": [
        "id",
        "ok"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "method"
            ]
          },
          {
            "required": [
              "error"
            ]
          },
          {
            "required": [
              "stream"
            ]
          },
          {
            "required": [
              "capabilities"
            ]
          }
        ]
      }
    },
    {
      "properties": {
        "type": {
          "const": "response"
        },
        "ok": {
          "const": false
        }
      },
      "required": [
        "id",
        "ok",
        "error"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "payload"
            ]
          },
          {
            "required": [
              "method"
            ]
          },
          {
            "required": [
              "stream"
            ]
          },
          {
            "required": [
              "capabilities"
            ]
          }
        ]
      }
    },
    {
      "properties": {
        "type": {
          "const": "notification"
        }
      },
      "required": [
        "method"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "id"
            ]
          },
          {
            "required": [
              "ok"
            ]
          },
          {
            "required": [
              "error"
            ]
          },
          {
            "required": [
              "stream"
            ]
          },
          {
            "required": [
              "capabilities"
            ]
          }
        ]
      }
    },
    {
      "properties": {
        "type": {
          "const": "stream"
        }
      },
      "required": [
        "id",
        "stream"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "method"
            ]
          },
          {
            "required": [
              "ok"
            ]
          },
          {
            "required": [
              "capabilities"
            ]
          }
        ]
      }
    },
    {
      "properties": {
        "type": {
          "const": "cancel"
        }
      },
      "required": [
        "id"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "payload"
            ]
          },
          {
            "required": [
              "method"
            ]
          },
          {
            "required": [
              "ok"
            ]
          },
          {
            "required": [
              "error"
            ]
          },
          {
            "required": [
              "stream"
            ]
          },
          {
            "required": [
              "capabilities"
            ]
          }
        ]
      }
    },
    {
      "properties": {
        "type": {
          "enum": [
            "hello",
            "hello-ack"
          ]
        }
      },
      "required": [
        "capabilities"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "id"
            ]
          },
          {
            "required": [
              "method"
            ]
          },
          {
            "required": [
              "ok"
            ]
          },
          {
            "required": [
              "error"
            ]
          },
          {
            "required": [
              "stream"
            ]
          },
          {
            "required": [
              "payload"
            ]
          }
        ]
      }
    }
  ],
  "$defs": {
    "json": {
      "anyOf": [
        {
          "type": [
            "string",
            "number",
            "boolean",
            "null"
          ]
        },
        {
          "type": "array",
          "items": {
            "$ref": "#/$defs/json"
          }
        },
        {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/json"
          }
        }
      ]
    },
    "reference": {
      "type": "object",
      "required": [
        "id",
        "version"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "capabilities": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "services": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        },
        "events": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        },
        "capabilities": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "features": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "error": {
      "type": "object",
      "required": [
        "code",
        "message"
      ],
      "additionalProperties": false,
      "properties": {
        "code": {
          "enum": [
            "MANIFEST_MISMATCH",
            "INSTANCE_CONFLICT",
            "SCOPE_DISPOSED",
            "RUNTIME_DISPOSED",
            "SERVICE_NOT_DECLARED",
            "EVENT_NOT_DECLARED",
            "MIDDLEWARE_CONFLICT",
            "MIDDLEWARE_CYCLE",
            "RETRY_NOT_ALLOWED",
            "CAPABILITY_NOT_DECLARED",
            "CAPABILITY_NOT_GRANTED",
            "SERVICE_NOT_READY",
            "SERVICE_NOT_FOUND",
            "METHOD_NOT_FOUND",
            "PERMISSION_DENIED",
            "REQUEST_TIMEOUT",
            "PLUGIN_UNAVAILABLE",
            "INVALID_REQUEST",
            "INVALID_PAYLOAD",
            "REQUEST_CANCELLED",
            "PROTOCOL_MISMATCH",
            "INVALID_MANIFEST",
            "INVALID_CONFIG",
            "DEPENDENCY_NOT_FOUND",
            "DEPENDENCY_CYCLE",
            "VERSION_MISMATCH",
            "SERVICE_CONFLICT",
            "INVALID_LIFECYCLE_STATE",
            "PLUGIN_START_FAILED",
            "PLUGIN_STOP_FAILED",
            "DISPOSE_FAILED",
            "INTERNAL_ERROR"
          ]
        },
        "message": {
          "type": "string"
        },
        "data": {
          "$ref": "#/$defs/json"
        }
      }
    }
  }
}
