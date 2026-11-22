/* Доступ к разметке. Элементы берутся по id каждый раз заново: модули
   интерфейса работают с разными их типами (select, input, div), и строгий
   тип тут только мешал бы — потому any, как и было в main.js. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const $ = (id: string): any => document.getElementById(id);

/** Контейнер сцены: ловит жесты, по нему меряется размер рендера */
export const stage = $('stage') as HTMLElement;
