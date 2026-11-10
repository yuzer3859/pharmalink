// Work 122: proof of delivery and the cash collected at the door (module-08 §9.2, BRULE-29).
// The job's `rules` (Work 121) say what completing it demands; the backend still decides.

/** The server's artifact limit (`delivery.podMaxArtifactBytes`, 48 KiB by default). */
export const MAX_ARTIFACT_BYTES = 49_152

/** What the door screen must ask for, from the job's rules. */
export function proofPlan(rules) {
  const requirement = rules?.podRequirement ?? 'NONE'
  return {
    requirement,
    /** A signature or a photo is required (`ARTIFACT`). */
    needsArtifact: requirement === 'ARTIFACT',
    /** The recipient's own confirmation is required (`CONFIRMATION`, also accepted for `NONE`). */
    needsConfirmation: requirement === 'CONFIRMATION',
    recordCash: false,
  }
}

/** Decoded size of a base64 string, in bytes. */
export function base64Bytes(b64) {
  const clean = (b64 ?? '').replace(/\s/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.floor((clean.length * 3) / 4) - padding
}

/** `data:<type>;base64,<data>` to the API's artifact shape, or null when it is not one. */
export function dataUrlToArtifact(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl ?? '')
  return match ? { contentType: match[1].toLowerCase(), contentBase64: match[2] } : null
}

/**
 * Builds the proof body. Signature or photo when one was taken (the strongest proof wins), otherwise
 * the recipient's confirmation. Returns `{ proof, problem }`; `problem` says what is still missing.
 */
export function buildProof({ plan, recipientName, recipientConfirmed, signature, photo }) {
  const artifact = photo ?? signature ?? null
  const name = recipientName?.trim() || undefined
  if (plan.needsArtifact && !artifact) return { proof: null, problem: 'This delivery needs the customer’s signature or a photo.' }
  if (artifact && base64Bytes(artifact.contentBase64) > MAX_ARTIFACT_BYTES) {
    return { proof: null, problem: 'The picture is too large. Take it again closer up.' }
  }
  if (!artifact && !recipientConfirmed) {
    return { proof: null, problem: 'Confirm the customer received the order.' }
  }
  return {
    proof: {
      type: photo ? 'PHOTO' : signature ? 'SIGNATURE' : 'CONFIRMATION',
      ...(name ? { recipientName: name } : {}),
      recipientConfirmed: !!recipientConfirmed,
      ...(artifact ? { artifact } : {}),
    },
    problem: null,
  }
}

/** The cash amount typed in birr, as santim; null when it is not a whole number of santim ≥ 0. */
export function cashToSantim(birr) {
  const value = Number(String(birr).replace(',', '.'))
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

export function deliverErrorMessage(error) {
  if (error?.status === 0) return 'No connection to PharmaLink. Nothing more was recorded; try again when you have signal.'
  if (error?.code === 'POD_REQUIRED') {
    return error?.details?.requirement === 'ARTIFACT'
      ? 'PharmaLink needs the customer’s signature or a photo for this delivery.'
      : 'PharmaLink needs the customer to confirm they received the order.'
  }
  if (error?.code === 'BUSINESS_RULE_VIOLATION' && /amount/i.test(error?.message ?? '')) return 'The cash recorded must be the exact amount due.'
  if (/collection/i.test(error?.message ?? '') && error?.status === 409) return error.message
  return error?.message || 'The delivery could not be recorded. Try again.'
}

/**
 * Shrinks a photo until it fits the server's artifact limit, as a JPEG data URL. Browser only
 * (canvas); the tests inject a stand-in.
 */
export async function shrinkPhoto(file, { maxBytes = MAX_ARTIFACT_BYTES, doc = document } = {}) {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('That file is not a picture.'))
      image.src = url
    })
    for (const side of [960, 720, 540, 400, 300]) {
      const scale = Math.min(1, side / Math.max(img.width, img.height))
      const canvas = doc.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.7, 0.5, 0.35]) {
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        const artifact = dataUrlToArtifact(dataUrl)
        if (artifact && base64Bytes(artifact.contentBase64) <= maxBytes) return artifact
      }
    }
    throw new Error('The picture could not be made small enough. Take it again closer up.')
  } finally {
    URL.revokeObjectURL(url)
  }
}
