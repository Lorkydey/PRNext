export async function GET(request){const q=new URL(request.url).searchParams.get('q');await new Promise(resolve=>setTimeout(resolve,30));return Response.json({service:'orion-slow',q})}
