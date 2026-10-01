import { requireSession } from "@/lib/auth/session";
import { writeDurableImage } from "@/lib/memory/store";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  const session = requireSession(request);
  if (session instanceof Response) return session;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Send the image as multipart/form-data." }, { status: 400 });
  }
  const image = formData.get("image");

  if (!(image instanceof File)) {
    return Response.json({ error: "Upload an image using the image field." }, { status: 400 });
  }

  if (image.type !== "image/jpeg") {
    return Response.json({ error: "The proof of concept accepts JPEG images only." }, { status: 415 });
  }

  if (image.size === 0 || image.size > MAX_IMAGE_BYTES) {
    return Response.json({ error: "The JPEG must be between 1 byte and 10 MB." }, { status: 400 });
  }

  // Stored per tenant and user, so one visitor's reference image is never shown to another.
  await writeDurableImage(
    { tenantId: session.tenantId, userId: session.userId },
    new Uint8Array(await image.arrayBuffer()),
  );

  return Response.json({ saved: true });
}
