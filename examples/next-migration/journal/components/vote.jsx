import{useState}from'react';export default function Vote(){const[n,set]=useState(0);return <button onClick={()=>set(n+1)}>Utile {n}</button>}
