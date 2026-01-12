const LATANIME_URL = "https://latanime.org";
const ITEMS_PER_PAGE = 28;

function normalizeId(id) {
    return id.replace(/^latanime-/, '').split('/').filter(x => x).pop().split('?')[0];
}

module.exports = {
    LATANIME_URL,
    ITEMS_PER_PAGE,
    normalizeId
};
