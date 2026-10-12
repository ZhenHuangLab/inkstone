import { describe, expect, test } from 'bun:test'
import { activeOrgFromCookie, selectOrgId } from '../src/sites/claude/organization'

const organizations = [{ uuid: 'personal', name: 'Personal' }, { uuid: 'team', name: 'Team' }]
const unexpectedChoice = (): never => { throw new Error('不应要求选择') }

describe('Claude 工作区选择', () => {
  test('当前工作区不是数组第一项时仍选中当前工作区', () => {
    expect(selectOrgId(organizations, 'team', unexpectedChoice)).toBe('team')
  })

  test('只有一个成员组织时可直接选择', () => {
    expect(selectOrgId([organizations[1]!], null, unexpectedChoice)).toBe('team')
  })

  test('cookie 缺失或不属于成员组织时，多组织账号必须选择', () => {
    for (const active of [null, 'stale']) {
      let choices = 0
      expect(selectOrgId(organizations, active, (available) => {
        choices++
        expect(available).toEqual(organizations)
        return 'team'
      })).toBe('team')
      expect(choices).toBe(1)
    }
  })

  test('取消或选择不在列表内的工作区会停止，不回退第一项', () => {
    for (const answer of [null, '', 'other']) {
      expect(() => selectOrgId(organizations, null, () => answer)).toThrow('未选择 Claude 工作区')
    }
  })

  test('无成员组织报错，重复组织不造成错误的选择要求', () => {
    expect(() => selectOrgId([], 'team', unexpectedChoice)).toThrow('拿不到组织 id')
    expect(selectOrgId([organizations[1]!, organizations[1]!], null, unexpectedChoice)).toBe('team')
  })

  test('cookie 解析处理边界、编码和损坏值', () => {
    expect(activeOrgFromCookie('a=1; lastActiveOrg=team%2D2; b=2')).toBe('team-2')
    expect(activeOrgFromCookie('lastActiveOrg=team')).toBe('team')
    expect(activeOrgFromCookie('otherlastActiveOrg=team')).toBeNull()
    expect(activeOrgFromCookie('lastActiveOrg=%oops')).toBeNull()
    expect(activeOrgFromCookie('')).toBeNull()
  })
})
