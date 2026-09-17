import {useEffect,useRef,useState} from 'react';
import type {WalletOption} from './wallet';
export function QrWalletButton({onConnect,disabled}:{onConnect:(wallet:WalletOption)=>Promise<void>;disabled:boolean}) {
 const [pending,setPending]=useState(false),[error,setError]=useState('');
 const abort=useRef<AbortController|null>(null);
 useEffect(()=>()=>abort.current?.abort(),[]);
 async function connect(button:HTMLButtonElement){
  if(pending||disabled)return;
  const dialog=button.closest('dialog');
  dialog?.close();
  const controller=new AbortController();abort.current=controller;setPending(true);setError('');
  try{const {connectQrWallet}=await import('./qr-wallet');const wallet=await connectQrWallet(controller.signal);if(controller.signal.aborted){wallet.provider.disconnect?.();return;}await onConnect(wallet);}
  catch{if(!controller.signal.aborted)setError('Connection closed or unavailable. Check your mobile wallet and try again.');}
  finally{if(!controller.signal.aborted){setPending(false);if(dialog?.isConnected)dialog.showModal();}}
 }
 return <div className="qr-wallet-option"><button className="wallet-option" disabled={disabled||pending} onClick={event=>void connect(event.currentTarget)}><span className="wallet-option-icon" aria-hidden="true">▦</span><span><strong>Connect with QR</strong><small>Postern mobile · Reown WalletConnect</small></span></button>{pending&&<button className="button secondary full-width" onClick={()=>{abort.current?.abort();setPending(false);}}>Cancel QR connection</button>}{error&&<p role="alert" className="form-error">{error}</p>}<p className="microcopy">In Postern Wallet, choose Scan QR code. Approve sharing your account on Bloch L2 testnet. Connection does not authorize transactions.</p></div>;
}
