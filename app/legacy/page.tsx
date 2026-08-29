"use client";

import { FormEvent, useEffect, useState } from "react";

type Member = { id:string; name:string; shareNumber:string; balance:string; status:string; lastActivity:string };
const MEMBERS: Record<string, Member> = {
  "12345": { id:"12345", name:"Maria Santos", shareNumber:"01", balance:"$2,458.17", status:"Active", lastActivity:"08/21/2026" },
  "24680": { id:"24680", name:"David Chen", shareNumber:"01", balance:"$987.03", status:"Active", lastActivity:"08/19/2026" },
  "31415": { id:"31415", name:"Avery Morgan", shareNumber:"01", balance:"$12,104.62", status:"Restricted", lastActivity:"07/30/2026" }
};

export default function LegacyPortal() {
  const [variant,setVariant] = useState<"main"|"east">("main");
  const [memberNumber,setMemberNumber] = useState("");
  const [member,setMember] = useState<Member|null>(null);
  const [searched,setSearched] = useState(false);
  const [loading,setLoading] = useState(false);
  const [permissionPending,setPermissionPending] = useState(false);
  const [faultState,setFaultState] = useState<"session_expired"|"application_error"|null>(null);

  useEffect(() => {
    const selected = new URLSearchParams(window.location.search).get("variant") === "east" ? "east" : "main";
    const variantFrame = window.requestAnimationFrame(() => setVariant(selected));
    return () => window.cancelAnimationFrame(variantFrame);
  }, []);

  function search(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedMemberNumber = String(new FormData(event.currentTarget).get(variant === "east" ? "member_number_east" : "member_number") ?? "");
    const fault = new URLSearchParams(window.location.search).get("fault");
    const delay = fault === "slow_load" ? 6000 : 650;
    setMemberNumber(submittedMemberNumber); setLoading(true); setSearched(false); setMember(null); setPermissionPending(false); setFaultState(null);
    window.setTimeout(() => {
      if (fault === "session_expired") { setFaultState("session_expired"); setLoading(false); return; }
      if (fault === "application_error") { setFaultState("application_error"); setLoading(false); return; }
      if (submittedMemberNumber === "31415") { setPermissionPending(true); setLoading(false); return; }
      setMember(MEMBERS[submittedMemberNumber] || null); setSearched(true); setLoading(false);
    },delay);
  }

  function approveRestrictedLookup() {
    setPermissionPending(false); setLoading(true);
    window.setTimeout(() => { setMember(MEMBERS["31415"]); setSearched(true); setLoading(false); },350);
  }

  return <main className="legacy-shell">
    <div className="legacy-titlebar"><strong>NORTHSTAR COMMUNITY CREDIT UNION</strong><span>CORE MEMBER SERVICES v8.4</span></div>
    <table className="legacy-nav" role="presentation"><tbody><tr><td className="active">Member Inquiry</td><td>Account Maintenance</td><td>Teller Processing</td><td>End-of-Day</td><td>Sign Off</td></tr></tbody></table>
    <div className="legacy-content">
      <div className="legacy-crumb">MAIN MENU &gt; MEMBER SERVICES &gt; MEMBER INQUIRY</div>
      <div className="legacy-window">
        <div className="legacy-window-title">Member Inquiry Selection</div>
        <form onSubmit={search}>
          <table className="legacy-form-table"><tbody>
            <tr><th>Member Number:</th><td><input name={variant === "east" ? "member_number_east" : "member_number"} value={memberNumber} onChange={(event)=>setMemberNumber(event.target.value.replace(/\D/g,"").slice(0,5))} maxLength={5} autoComplete="off" /></td></tr>
            <tr><th>Inquiry Type:</th><td><select name="inquiry_type" defaultValue="summary"><option value="summary">Member / Account Summary</option><option value="shares">Share Accounts Only</option></select></td></tr>
          </tbody></table>
          <div className="legacy-actions"><button type="submit" disabled={loading}>{loading?"PLEASE WAIT...":variant === "east" ? "Find Member" : "Retrieve Record"}</button><button type="button" onClick={()=>{setMemberNumber("");setMember(null);setSearched(false);setPermissionPending(false);setFaultState(null)}}>Clear</button></div>
        </form>
      </div>
      {permissionPending && <div className="legacy-dialog" role="dialog" aria-labelledby="permission-title">
        <div id="permission-title" className="legacy-dialog-title">ADDITIONAL AUTHORIZATION REQUIRED</div>
        <p>This restricted account requires an operator acknowledgment before the inquiry can continue.</p>
        <div className="legacy-actions"><button type="button" onClick={approveRestrictedLookup}>Continue lookup</button></div>
      </div>}
      {faultState === "session_expired" && <div className="legacy-message"><strong>SESSION 401:</strong> OPERATOR SESSION EXPIRED. SIGN IN AGAIN BEFORE RETRY.</div>}
      {faultState === "application_error" && <div className="legacy-message"><strong>SYSTEM 500:</strong> CORE MEMBER SERVICES IS UNAVAILABLE.</div>}
      {searched && !member && <div className="legacy-message"><strong>MESSAGE 104:</strong> MEMBER NUMBER NOT FOUND. VERIFY NUMBER AND RETRY.</div>}
      {member && <div className="legacy-window member-result">
        <div className="legacy-window-title">Member / Account Summary</div>
        <table className="member-header"><tbody><tr><th>Member:</th><td>{member.id}</td><th>Name:</th><td>{member.name}</td></tr><tr><th>Branch:</th><td>001 - MAIN</td><th>Relationship:</th><td>PRIMARY</td></tr></tbody></table>
        <table className="accounts-grid"><thead><tr><th>Share</th><th>Description</th><th>Current Balance</th><th>Status</th><th>Last Activity</th></tr></thead><tbody><tr><td>{member.shareNumber}</td><td>REGULAR SAVINGS</td><td className="money savings-balance">{member.balance}</td><td className="account-status">{member.status}</td><td>{member.lastActivity}</td></tr></tbody></table>
        <div className="legacy-footer-help">F1=Help&nbsp;&nbsp; F3=Exit&nbsp;&nbsp; F5=Refresh&nbsp;&nbsp; F12=Previous</div>
      </div>}
    </div>
    <footer className="legacy-statusbar"><span>USER: DEMO.OPERATOR</span><span>TERMINAL: WS-014</span><span>SESSION ACTIVE</span></footer>
  </main>;
}
