import { describe, expect, it, vi } from 'vitest'
import { base64Bytes, buildProof, cashToSantim, dataUrlToArtifact, deliverErrorMessage, MAX_ARTIFACT_BYTES, proofPlan } from './proof'
import { createDriverService } from '../jobs/driverService'

const png = { contentType: 'image/png', contentBase64: 'iVBORw0KGgo=' }

describe('what the door screen asks for (Work 122)', () => {
  it('follows the job’s PoD rule', () => {
    expect(proofPlan(undefined)).toMatchObject({ requirement: 'NONE', needsArtifact: false, needsConfirmation: false })
    expect(proofPlan({ podRequirement: 'CONFIRMATION' })).toMatchObject({ needsConfirmation: true, needsArtifact: false })
    expect(proofPlan({ podRequirement: 'ARTIFACT' })).toMatchObject({ needsArtifact: true })
  })
})

describe('buildProof', () => {
  const none = proofPlan({ podRequirement: 'NONE' })
  const artifact = proofPlan({ podRequirement: 'ARTIFACT' })

  it('sends the recipient’s confirmation when no picture was taken', () => {
    expect(buildProof({ plan: none, recipientName: ' Selam ', recipientConfirmed: true })).toEqual({
      proof: { type: 'CONFIRMATION', recipientName: 'Selam', recipientConfirmed: true },
      problem: null,
    })
    expect(buildProof({ plan: none, recipientName: '', recipientConfirmed: false }).problem).toMatch(/Confirm/)
  })

  it('prefers a photo, then a signature, and needs one when the rule says ARTIFACT', () => {
    expect(buildProof({ plan: artifact, recipientConfirmed: true }).problem).toMatch(/signature or a photo/)
    expect(buildProof({ plan: artifact, recipientConfirmed: false, signature: png }).proof).toMatchObject({ type: 'SIGNATURE', artifact: png })
    const photo = { contentType: 'image/jpeg', contentBase64: 'AAAA' }
    expect(buildProof({ plan: artifact, recipientConfirmed: true, signature: png, photo }).proof).toMatchObject({ type: 'PHOTO', artifact: photo, recipientConfirmed: true })
  })

  it('refuses a picture over the server’s limit before sending it', () => {
    const big = { contentType: 'image/jpeg', contentBase64: 'A'.repeat(Math.ceil((MAX_ARTIFACT_BYTES + 10) / 3) * 4) }
    expect(buildProof({ plan: artifact, photo: big }).problem).toMatch(/too large/)
  })
})

describe('helpers', () => {
  it('measure base64 and read data URLs', () => {
    expect(base64Bytes('AAAA')).toBe(3)
    expect(base64Bytes('AAA=')).toBe(2)
    expect(base64Bytes('AA==')).toBe(1)
    expect(dataUrlToArtifact('data:image/PNG;base64,abcd')).toEqual({ contentType: 'image/png', contentBase64: 'abcd' })
    expect(dataUrlToArtifact('nope')).toBeNull()
  })

  it('turn typed birr into santim', () => {
    expect(cashToSantim('57')).toBe(5700)
    expect(cashToSantim('57,5')).toBe(5750)
    expect(cashToSantim('-1')).toBeNull()
    expect(cashToSantim('abc')).toBeNull()
  })

  it('word delivery refusals plainly', () => {
    expect(deliverErrorMessage({ status: 422, code: 'POD_REQUIRED', details: { requirement: 'ARTIFACT' } })).toMatch(/signature or a photo/)
    expect(deliverErrorMessage({ status: 422, code: 'POD_REQUIRED', details: { requirement: 'CONFIRMATION' } })).toMatch(/confirm/)
    expect(deliverErrorMessage({ status: 422, code: 'BUSINESS_RULE_VIOLATION', message: 'The collected amount does not match the amount due for this delivery.' })).toMatch(/exact amount/)
    expect(deliverErrorMessage({ status: 0 })).toMatch(/No connection/)
  })
})

describe('door calls', () => {
  it('record cash in santim as CASH, capture the proof and deliver', async () => {
    const request = vi.fn().mockResolvedValue({})
    const s = createDriverService(request)
    await s.recordCash('job-1', 5700)
    expect(request).toHaveBeenLastCalledWith('POST', '/delivery/jobs/job-1/cod-collection', { collectedAmount: 5700, method: 'CASH' })
    await s.captureProof('job-1', { type: 'CONFIRMATION', recipientConfirmed: true })
    expect(request).toHaveBeenLastCalledWith('POST', '/delivery/jobs/job-1/proof-of-delivery', { type: 'CONFIRMATION', recipientConfirmed: true })
    await s.deliver('job-1')
    expect(request).toHaveBeenLastCalledWith('POST', '/delivery/jobs/job-1/deliver', {})
  })
})
