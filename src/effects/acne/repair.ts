// Local blemish repair: finds small red spots against a blurred baseline and paints them
// over with the surrounding skin colour and lighting.
export function repairBlemishes(
  source: Uint8ClampedArray,
  baseline: Uint8ClampedArray,
  skin: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray<ArrayBuffer> {
  const output=new Uint8ClampedArray(source.length),seed=new Uint8Array(width*height),seen=new Uint8Array(width*height);
  const red=(r: number,g: number,b: number)=>(r-(g+b)/2)/Math.max(30,r+g+b);
  for(let p=0;p<seed.length;p++){
    const i=p*4;
    if(skin[i+3]<250)continue;
    const delta=red(source[i],source[i+1],source[i+2])-red(baseline[i],baseline[i+1],baseline[i+2]);
    // Darkness alone is not acne: it includes pores, facial contours and hair.
    seed[p]=delta>0.006 && source[i]>source[i+1]*1.12 ? 1 : 0;
  }
  for(let start=0;start<seed.length;start++){
    if(!seed[start]||seen[start])continue;
    const queue: number[]=[start];seen[start]=1;
    let minX=width,maxX=0,minY=height,maxY=0;
    for(let n=0;n<queue.length;n++){
      const p=queue[n],x=p%width,y=Math.floor(p/width);
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){
        const xx=x+dx,yy=y+dy,q=yy*width+xx;
        if(xx>=0&&xx<width&&yy>=0&&yy<height&&seed[q]&&!seen[q]){seen[q]=1;queue.push(q);}
      }
    }
    const bw=maxX-minX+1,bh=maxY-minY+1;
    // Reject isolated noise, broad redness, wrinkles and elongated boundaries.
    // A raised blemish and its red halo can span more than two radii.
    // Bound area as well as extent so local spots survive without admitting
    // broad cheek redness or long feature boundaries.
    if(queue.length<3||bw>radius*3||bh>radius*3||queue.length>radius*radius*3||Math.max(bw/bh,bh/bw)>2.4)continue;
    const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
    const rx=Math.max(2,bw*.65+1),ry=Math.max(2,bh*.65+1);
    const ring=Math.max(radius,Math.max(rx,ry)*1.7);
    const samples: number[][]=[];
    for(let k=0;k<32;k++){
      const a=k*Math.PI/16,x=Math.round(cx+Math.cos(a)*ring),y=Math.round(cy+Math.sin(a)*ring);
      if(x<0||x>=width||y<0||y>=height)continue;
      const p=y*width+x,i=p*4;
      if(skin[i+3]<250||seed[p])continue;
      samples.push([source[i],source[i+1],source[i+2],(x-cx)/ring,(y-cy)/ring]);
    }
    if(samples.length<16)continue;
    // Hair/skin mixtures are unsuitable donors: replacing them paints over a beard.
    const light=samples.map(v=>v[0]*.2126+v[1]*.7152+v[2]*.0722).sort((a,b)=>a-b);
    if(light[Math.floor(light.length*.85)]-light[Math.floor(light.length*.15)]>40)continue;
    // Trim extremes, retaining a consistent local skin colour for each spot.
    const target=[0,1,2].map(ch=>{
      const vals=samples.map(v=>v[ch]).sort((a,b)=>a-b),trim=Math.floor(vals.length*.2);
      const middle=vals.slice(trim,vals.length-trim);return middle.reduce((a,b)=>a+b,0)/middle.length;
    });
    // Fit the surrounding illumination, rather than painting a flat-colour
    // disk across a nose/cheek gradient. Robust weights reject donor outliers.
    const plane: [number,number,number][]=[0,1,2].map((ch): [number,number,number]=>{
      let sw=0,sx=0,sy=0,sxx=0,sxy=0,syy=0,sz=0,sxz=0,syz=0;
      for(const sample of samples){
        const x=sample[3],y=sample[4],z=sample[ch];
        const weight=1/(1+Math.pow((z-target[ch])/24,2));
        sw+=weight;sx+=weight*x;sy+=weight*y;sxx+=weight*x*x;sxy+=weight*x*y;syy+=weight*y*y;
        sz+=weight*z;sxz+=weight*x*z;syz+=weight*y*z;
      }
      const a=sxx-sx*sx/sw,b=sxy-sx*sy/sw,c=syy-sy*sy/sw;
      const u=sxz-sx*sz/sw,v=syz-sy*sz/sw,det=a*c-b*b;
      if(det<1e-5)return [target[ch],0,0];
      const dx=(u*c-v*b)/det,dy=(v*a-u*b)/det;
      return [(sz-dx*sx-dy*sy)/sw,dx,dy];
    });
    for(let y=Math.max(0,Math.floor(cy-ry));y<=Math.min(height-1,Math.ceil(cy+ry));y++)for(let x=Math.max(0,Math.floor(cx-rx));x<=Math.min(width-1,Math.ceil(cx+rx));x++){
      const d=Math.hypot((x-cx)/rx,(y-cy)/ry);if(d>=1)continue;
      const p=y*width+x,i=p*4;
      const local=plane.map(v=>Math.max(0,Math.min(255,v[0]+v[1]*(x-cx)/ring+v[2]*(y-cy)/ring)));
      const sourceLum=source[i]*.2126+source[i+1]*.7152+source[i+2]*.0722;
      const targetLum=local[0]*.2126+local[1]*.7152+local[2]*.0722;
      // Preserve dark strands and neutral grey hairs, even if segmentation calls them skin.
      const luminanceMatch=Math.max(0,Math.min(1,(55-Math.abs(sourceLum-targetLum))/30));
      const redness=red(source[i],source[i+1],source[i+2]);
      const skinColor=Math.max(0,Math.min(1,(redness-.025)/.025));
      const t=Math.max(0,Math.min(1,(1-d)/.45));
      const alpha=t*t*(3-2*t)*skin[i+3]/255*.98*luminanceMatch*skinColor;
      if(alpha*255<=output[i+3])continue;
      for(let ch=0;ch<3;ch++){
        const detail=Math.max(-4,Math.min(4,(source[i+ch]-baseline[i+ch])*.18));
        output[i+ch]=local[ch]+detail;
      }
      output[i+3]=alpha*255;
    }
  }
  return output;
}
