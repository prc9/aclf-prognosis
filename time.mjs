// Timezone-free clinical wall-clock time, shared by the current rolling UI.
export function timestamp(text){
 if(typeof text!=='string')throw Error('Enter a complete local date and time / 请填写完整的本地日期和时间');
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text);
 if(!m)throw Error('Use a local date/time without a timezone / 时间须为无时区的本地日期和时间');
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(x=>Number(x||0)),d=new Date(0);
 d.setUTCFullYear(year,month-1,day);d.setUTCHours(hour,minute,second,Number((m[7]||'').padEnd(3,'0')));
 if(year<1||d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day||d.getUTCHours()!==hour||d.getUTCMinutes()!==minute||d.getUTCSeconds()!==second)throw Error('Invalid local date/time / 日期或时间无效');
 return d.getTime();
}
