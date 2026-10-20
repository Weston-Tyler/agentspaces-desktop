const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function discussionLocation(href){
 const url=new URL(href),id=url.searchParams.get('discussionId'),messageId=url.searchParams.get('messageId');
 return url.searchParams.get('view')==='discussions'&&uuid.test(id??'')?{id,messageId:uuid.test(messageId??'')?messageId:null}:null;
}
export function discussionHref(id,messageId){
 return '/?'+new URLSearchParams({view:'discussions',discussionId:id,messageId}).toString();
}
