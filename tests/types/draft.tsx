import { draftMode } from 'next/headers';
import type { NextApiHandler, GetStaticProps } from 'rustyx';

export async function GET() {
  const draft = await draftMode();
  if (draft.isEnabled) draft.disable(); else draft.enable();
  return Response.json({ enabled: draft.isEnabled });
}
export const handler: NextApiHandler = (request, response) => {
  response.setDraftMode({ enable: !request.draftMode }).json({ preview: request.preview });
};
export const getStaticProps: GetStaticProps<{ draft: boolean }> = ({ draftMode }) => ({ props: { draft: draftMode } });
