const { CLAUDE_MODELS, PLATFORM_TEST_MODELS } = require('../config/models')

describe('models config', () => {
  it('lists current Claude models first so test defaults are not outdated', () => {
    expect(CLAUDE_MODELS.slice(0, 2).map((model) => model.value)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5'
    ])
    expect(PLATFORM_TEST_MODELS.claude[0].value).toBe('claude-opus-5-5')
  })

  it('does not offer retired Claude models', () => {
    const values = CLAUDE_MODELS.map((model) => model.value)
    expect(values).not.toContain('claude-3-5-haiku-20241022')
    expect(values).not.toContain('claude-opus-4-1-20250805')
  })
})
