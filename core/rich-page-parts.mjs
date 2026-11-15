import {EditorState} from '@tiptap/pm/state';
// Each header/footer variant is an independent story. History must never cross stories.
export function storyEditorState(state,doc){return EditorState.create({schema:state.schema,doc:state.schema.nodeFromJSON(doc),plugins:state.plugins});}
export function appendPageNumber(story,total=false,align='center'){
 const next=structuredClone(story??{type:'doc',content:[]});
 if(next.type!=='doc'||!Array.isArray(next.content))throw Error('Invalid header/footer story');
 const field=kind=>({type:'wordField',attrs:{kind},...(total?{marks:[{type:'bold'}]}:{})});
 next.content.push({type:'paragraph',attrs:{textAlign:align},content:total?[{type:'text',text:'Page '},field('PAGE'),{type:'text',text:' of '},field('NUMPAGES')]:[field('PAGE')]});return next;
}
