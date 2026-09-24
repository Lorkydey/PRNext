export default async function handler(req,res){if(req.method!=='POST')return res.status(405).json({error:'method'});await res.revalidate('/revision');res.json({revalidated:true})}
