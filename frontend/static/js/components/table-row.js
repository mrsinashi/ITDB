// Строка главной таблицы (Компьютеры и Принтеры) – своим компонентом (этап 52). Vue
// перерисовывает её, только когда меняется то, что она читает (её данные, выделение, правка в
// ней, оформление и столбцы), а не на каждое изменение страницы (тост, подсказка, буква в поле,
// наведение): 600 строк перерисовывались за 0,3 с, на слабом ПК – больше секунды.
// Методы ячеек – у корня (mixins/table.js и др.), здесь – через root. То, что меняется у одной
// строки, приходит свойствами, а не читается у корня (иначе изменение перерисует все строки):
// выделена ли, какое поле в ней правится, строка ниже (её заливка красит нижние линии).

const ROW_TEMPLATE = `
    <tr :data-id="row.id" :class="{ 'row-selected': selected }">
        <td v-for="col in root.viewColumns" :key="col.field"
            :class="root.cellClass(row, col, editField === col.field)"
            :style="root.cellTdStyle(row, col, fills, belowFills)"
            @mousedown="root.onCellMouseDown($event, row)"
            @click="root.onCellClick($event, row, col)"
            @dblclick="root.startEdit(row, col, $event)"
            @mouseenter="root.handleNoteEnter($event, row, col)"
            @mouseleave="root.hideNoteTooltip">
            <!-- «По правилу» (этап 36, кнопка «Имена по правилам»): имя по правилу у ПК, названного иначе -->
            <template v-if="col.virtual">
                <button v-if="root.nameChip(row)" type="button" class="scan-chip name-chip" :class="{ open: root.namePop && root.namePop.row.id === row.id }"
                    :title="root.nameChipTitle(row)" @mousedown.stop @dblclick.stop @click.stop="$event.altKey ? root.copyCellValue($event) : root.openNamePop(row, $event)">{{ root.nameChip(row) }}</button>
                <span v-else-if="root.nameKept(row)" class="name-kept" :title="'Своё имя · правило ' + root.nameChipTitle(row)">своё</span>
            </template>
            <!-- Антивирусы (этап 26д): строкой каждый, цвет – по состоянию (Справочники) -->
            <span v-else-if="col.field === 'antivirus'" class="av-cell"><span v-for="(a, ai) in root.avItems(row)" :key="ai" class="av-line" :class="{ 'av-chip': !!(root.avCellStyle(a) || {}).backgroundColor }" :style="root.avCellStyle(a)" :title="root.avTitle(a)">{{ a.title }}</span></span>
            <!-- Значения по строкам: повтор – блочком, логина нет в Jabber – красным, номер GLPI / GSIT – ссылкой -->
            <!-- Принтеры у ПК, ПК у принтера (этап 44): ссылки; при наведении – значок «показать в таблице» -->
            <span v-else-if="col.links && root.cellParts(row, col)" class="cell-lines" :style="root.cellSpanStyle(row, col, editField === col.field)"><span v-for="(p, pi) in root.cellParts(row, col)" :key="pi" class="cell-line obj-line"><a class="obj-link" :href="p.href" draggable="false" :title="p.title" @click.prevent="root.onObjLinkClick($event, p.obj)">{{ p.text }}</a><span class="obj-tbl" :title="p.obj.kind === 'pc' ? 'Показать в Компьютерах' : 'Показать в Принтерах'" @mousedown.stop @click.stop="root.showObjInTable(p.obj)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/></svg></span></span></span>
            <!-- «Доступ» (этап 45): заданные логин и пароль – точками; показанные по паролю – строками, ✎ – изменить -->
            <span v-else-if="col.secret && root.webShownFor(row) && editField !== col.field" class="secret-shown" :title="root.webAccessTitle(row)"><span class="cell-lines"><span class="cell-line" :class="{ 'cl-none': !root.webShown.login }">{{ root.webShown.login || "без логина" }}</span><span class="cell-line" :class="{ 'cl-none': !root.webShown.password }">{{ root.webShown.password || "без пароля" }}</span></span><span v-if="root.canEdit" class="secret-pen" title="Изменить" @mousedown.stop @dblclick.stop @click.stop="root.startWebEdit(row, 'cell')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg></span></span>
            <span v-else-if="col.secret && row.web_auth && editField !== col.field" class="secret-dots" :title="root.webAccessTitle(row)">{{ root.secretDots }}</span>
            <template v-else-if="col.secret"></template>
            <span v-else-if="root.cellParts(row, col)" class="cell-lines" :style="root.cellSpanStyle(row, col, editField === col.field)"><template v-for="(p, pi) in root.cellParts(row, col)" :key="pi"><a v-if="p.href" class="cell-line id-link" :class="p.cls" :href="p.href" target="_blank" rel="noopener" :title="p.title" @click="root.onIdLinkClick($event)">{{ p.text }}</a><a v-else-if="p.card" class="cell-line host-link" :class="p.cls" :style="p.style" :href="p.card" draggable="false" :title="p.title" @click.prevent>{{ p.text }}</a><span v-else class="cell-line" :class="p.cls" :style="p.style" :title="p.title" @dblclick="root.onCellValueDblclick($event, row, col)">{{ p.text }}</span></template></span>
            <span v-else :class="{ 'note-text': col.note, pending: root.isPending(row, col) }" :style="root.cellSpanStyle(row, col, editField === col.field)" @dblclick="root.onCellValueDblclick($event, row, col)">{{ root.cellText(row, col) }}</span>
            <button v-if="root.scanCellMark(row, col) && editField !== col.field" type="button" class="scan-chip"
                :class="{ open: root.scanPop && root.scanPop.row.id === row.id && root.scanPop.col.field === col.field }"
                :style="root.scanChipStyle(root.scanCellMark(row, col))" :title="root.scanChipTitle(root.scanCellDiff(row, col))"
                @mousedown.stop @dblclick.stop @click.stop="$event.altKey ? root.copyCellValue($event) : root.openScanPop(row, col, $event)">{{ root.scanChipText(root.scanCellDiff(row, col)) }}</button>
            <template v-if="editField === col.field">
                <!-- «Доступ» (этап 45): логин виден, пароль – точками; ячейка на время правки шире и выше -->
                <span v-if="col.secret && root.webEdit" class="secret-edit" @focusout="root.onWebEditFocusOut($event)"><input v-model="root.webEdit.login" class="cell-edit secret-input" placeholder="Логин" spellcheck="false" autocomplete="off" @keydown="root.onWebEditKeydown"><input v-model="root.webEdit.password" class="cell-edit secret-input" type="password" placeholder="Пароль" autocomplete="new-password" @keydown="root.onWebEditKeydown"></span>
                <location-picker v-else-if="col.location" editor input-class="cell-edit" :value="row.location_id" :options="root.locationOptions"
                    placeholder="Расположение…" @pick="root.onCellLocationPick(row, $event)" @cancel="root.cancelEdit"></location-picker>
                <textarea v-else-if="col.multiline && !col.cartridges" v-model="root.editValue"
                    @keydown="root.handleEditKeydown($event, row, col)"
                    @input="col.field === 'ip' && root.onIpInput($event, null, 'editValue'); root.onEditInput($event, col)"
                    @blur="root.saveEdit(row, col)"
                    class="cell-edit cell-edit-multi"></textarea>
                <input v-else v-model="root.editValue"
                    @keydown="root.handleEditKeydown($event, row, col)"
                    @input="root.onEditInput($event, col); root.onSuggestInput($event.target.value)"
                    @blur="root.saveEdit(row, col)"
                    class="cell-edit">
            </template>
        </td>
    </tr>
`;

const renderRow = Vue.compile(ROW_TEMPLATE);

export default {
    name: "table-row",
    inject: ["root"],
    props: {
        row: Object,
        below: Object,       // следующая строка на экране; null – эта последняя
        selected: Boolean,
        editField: String    // поле, которое правится в этой строке; null – никакое
    },
    computed: {
        // Заливка ячеек этой строки и строки ниже – для линий сетки (cellTdStyle)
        fills() {
            return this.root.rowFills(this.row);
        },
        belowFills() {
            return this.below ? this.root.rowFills(this.below) : null;
        }
    },
    // Шаблон получает простой объект с нужными именами, а не прокси компонента: каждое имя
    // шаблона Vue иначе ищет через прокси, а ячеек – 600 строк × 30 (полная перерисовка
    // была бы на четверть медленнее прежней). Читается то же – Vue следит, как обычно
    render(proxy, cache) {
        return renderRow({
            root: this.root,
            row: this.row,
            selected: this.selected,
            editField: this.editField,
            fills: this.fills,
            belowFills: this.belowFills
        }, cache);
    }
};
