const filters=require('./deal-filters');
function validate(settings){
 if(settings==null)return null;
 if(typeof settings!=='object'||Array.isArray(settings))return 'Invalid additional settings.';
 const allowed=['minPrice','maxPrice','maxDistance','maxItems','sortBy','filters','aiPrompt'];
 if(Object.keys(settings).some(key=>!allowed.includes(key)))return 'Unknown additional setting.';
 for(const key of ['minPrice','maxPrice'])if(settings[key]!=null&&(typeof settings[key]!=='number'||!Number.isFinite(settings[key])||settings[key]<0||settings[key]>9999999999))return 'Enter valid prices.';
 if(settings.minPrice!=null&&settings.maxPrice!=null&&settings.minPrice>settings.maxPrice)return 'Minimum price cannot exceed maximum price.';
 if(settings.maxDistance!=null&&(!Number.isInteger(settings.maxDistance)||settings.maxDistance<1||settings.maxDistance>100000))return 'Enter a valid distance.';
 if(settings.maxItems!=null&&(!Number.isInteger(settings.maxItems)||settings.maxItems<1||settings.maxItems>30))return 'Choose 1 to 30 listings per source.';
 if(settings.sortBy!=null&&!['suggested','date'].includes(settings.sortBy))return 'Choose a valid sort order.';
 if(settings.aiPrompt!=null&&(typeof settings.aiPrompt!=='string'||settings.aiPrompt.length>4000))return 'AI instructions must be 4000 characters or less.';
 if(settings.filters!=null){const error=filters.validate(settings.filters);if(error)return error;if(Object.keys(settings.filters).some(key=>!Object.hasOwn(filters.defaults,key)))return 'Unknown listing filter.';}
 return null;
}
module.exports={validate};
