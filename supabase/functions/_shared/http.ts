export class HttpInputError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function readJsonBody<T>(req: Request, maxBytes = 32_768): Promise<T> {
  const declaredLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpInputError('Payload too large', 413);
  }

  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new HttpInputError('Payload too large', 413);
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpInputError('Invalid JSON', 400);
  }
}
