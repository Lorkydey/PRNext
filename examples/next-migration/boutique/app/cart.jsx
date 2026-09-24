'use client';import{useState}from'react';export default function Cart(){const[n,set]=useState(0);return <button onClick={()=>set(n+1)}>Panier {n}</button>}
