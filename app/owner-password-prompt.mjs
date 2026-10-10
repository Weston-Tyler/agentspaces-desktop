import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
export async function hiddenPassword(label) {
 if(!process.stdin.isTTY)throw Error('Owner password setup requires an interactive terminal');
 const output=new Writable({write(_chunk,_encoding,done){done();}});
 const input=createInterface({input:process.stdin,output,terminal:true});
 process.stderr.write(label);
 try {return await new Promise((resolve,reject)=>{input.once('SIGINT',()=>reject(Error('Password setup cancelled')));input.question('',resolve);});}
 finally {input.close();output.end();process.stderr.write('\n');}
}
