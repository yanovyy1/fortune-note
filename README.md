# Fortune Note — карта мира

Интерактивная веб-карта вселенной на [Leaflet.js](https://leafletjs.com/),
задеплоенная на GitHub Pages.

## Структура

```
index.html          — разметка страницы
css/style.css        — стили (тёмная/светлая тема, глассморфизм)
js/map-config.js     — размеры и путь к файлу карты
js/app.js            — логика карты: слои, поиск, маркеры, тема
assets/map/          — сюда кладётся сам файл карты (SVG/PNG)
data/locations.json  — список локаций (см. схему ниже)
```

## Как добавить свою карту

1. Положите готовый файл в `assets/map/` (например `map.svg`).
2. В `js/map-config.js` укажите его размеры и путь:

```js
const MAP_CONFIG = {
  width: 2000,
  height: 2000,
  src: 'assets/map/map.svg',
};
```

Координаты локаций в `data/locations.json` — в тех же единицах, где
`(0, 0)` — левый верхний угол карты.

## Схема локации (`data/locations.json`)

```json
{
  "id": "unique-id",
  "name": "Название локации",
  "type": "kingdom | castle | ruins | settlement | water | place",
  "x": 700,
  "y": 600,
  "region": "необязательно — название региона",
  "era": "необязательно — эпоха/период",
  "description": "текст, показывается в карточке при клике"
}
```

## Локальный запуск

Статический сайт без сборки — нужен просто HTTP-сервер (иначе
`fetch()` данных не сработает из-за CORS у `file://`):

```bash
python3 -m http.server 8080
```

и открыть `http://localhost:8080`.

## Деплой на GitHub Pages

Settings → Pages → Source: `main` / `/ (root)`.
