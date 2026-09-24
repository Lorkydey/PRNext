'use server';import{cookies}from'next/headers';export async function identify(data){(await cookies()).set('visitor',String(data.get('name')||'Visiteur'),{path:'/',httpOnly:true})}
