'use client';import{useRouter}from'next/navigation';export default function Close(){const router=useRouter();return <button onClick={()=>router.back()}>Fermer</button>}
