import type { ClaudeOrganization } from './types'

export type OrganizationChooser = (organizations: readonly ClaudeOrganization[]) => string | null

/** Cookie 只作为当前工作区线索，必须与接口返回的成员组织匹配。 */
export function selectOrgId(
  organizations: readonly ClaudeOrganization[],
  activeOrgId: string | null,
  choose: OrganizationChooser,
): string {
  const memberships = [...new Map(
    organizations
      .filter((org) => typeof org?.uuid === 'string' && org.uuid !== '')
      .map((org) => [org.uuid, org]),
  ).values()]
  if (memberships.length === 0) throw new Error('拿不到组织 id：请确认已登录 claude.ai 后重试')
  if (activeOrgId && memberships.some((org) => org.uuid === activeOrgId)) return activeOrgId
  if (memberships.length === 1) return memberships[0]!.uuid

  const selected = choose(memberships)
  if (!selected || !memberships.some((org) => org.uuid === selected)) {
    throw new Error('未选择 Claude 工作区，已停止导出；请确认当前工作区后重试')
  }
  return selected
}

export function activeOrgFromCookie(cookie: string): string | null {
  const value = /(?:^|;\s*)lastActiveOrg=([^;]+)/.exec(cookie)?.[1]
  try {
    return value ? decodeURIComponent(value) : null
  } catch {
    return null
  }
}
