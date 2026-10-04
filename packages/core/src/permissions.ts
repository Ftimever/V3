import type { CapabilityAccess, JsonObject, PermissionGrant, PermissionId, PermissionRequest } from '@easybot/contracts'
import { CoreError } from './errors.js'
import type { LifecycleScope } from './scope.js'

export type { CapabilityAccess } from '@easybot/contracts'

function withinScope(scope: JsonObject | undefined, target: JsonObject | undefined): boolean {
  if (!scope) return true
  return Object.entries(scope).every(([key, constraint]) => {
    const value = target?.[key]
    if (Array.isArray(constraint)) return constraint.some(item => item === value)
    return constraint === value
  })
}

export function createCapabilityAccess(
  scope: LifecycleScope,
  declarations: readonly PermissionRequest[],
  policy: readonly PermissionRequest[],
  grants: readonly PermissionGrant[],
): CapabilityAccess {
  return Object.freeze({
    require(permission: PermissionId, target?: JsonObject): void {
      scope.assertActive()
      const declared = declarations.filter(request => request.id === permission)
      if (!declared.length) throw new CoreError('CAPABILITY_NOT_DECLARED', permission)
      const allowed = policy.filter(request => request.id === permission)
      const granted = grants.filter(grant => grant.id === permission)
      if (!allowed.length || !granted.length) throw new CoreError('CAPABILITY_NOT_GRANTED', permission)
      if (![declared, allowed, granted].every(layer => layer.some(request => withinScope(request.scope, target)))) {
        throw new CoreError('PERMISSION_DENIED', `Request exceeds permission scope: ${permission}`)
      }
    },
  })
}
