import{cookies}from'next/headers';export async function GET(){return Response.json({visitor:(await cookies()).get('visitor')?.value||'Visiteur'})}
