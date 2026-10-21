// Строка главной таблицы (Компьютеры, Принтеры, журналы) – своим компонентом (этап 52). Vue
// перерисовывает её, только когда меняется то, что она читает (её данные, выделение, правка в
// ней, оформление и столбцы), а не на каждое изменение страницы (тост, подсказка, буква в поле,
// наведение): 600 строк перерисовывались за 0,3 с, на слабом ПК – больше секунды.
// Методы ячеек – у корня (mixins/table.js и др.), здесь – через root. То, что меняется у одной
// строки, приходит свойствами, а не читается у корня (иначе изменение перерисует все строки):
// выделена ли, какое поле в ней правится, строка ниже (её заливка красит нижние линии).

const ROW_TEMPLATE = `
    <tr :data-id="row.id" :class="{ 'row-selected': selected }">
        <td v-for="col in root.viewColumns" :key="col.field"
            :class="[root.cellClass(row, col, editField === col.field), kit && col.field === 'inv_no' ? 'kit-' + kit : null]"
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
            <!-- Журнал «IP» (этап 71): источники – через запятую с переносом между ними; тип, имя, «Добавил» – строками
                 (откуда – в подсказке); имя ПК, принтера, записи «Движения» – ссылкой, при наведении – «Показать в таблице» -->
            <span v-else-if="col.ipCol && root.ipCellParts(row, col)" :class="col.ipCol === 'isrc' ? 'ip-src' : (col.ipCol === 'iname' ? 'cell-lines ip-names' : 'cell-lines')" :style="root.cellSpanStyle(row, col, editField === col.field)"><template v-for="(p, pi) in root.ipCellParts(row, col)" :key="pi"><span v-if="col.ipCol === 'isrc'" class="ip-src-part" :class="p.cls" :title="p.title">{{ p.text }}{{ p.sep }}</span><span v-else-if="p.obj" class="cell-line obj-line"><a class="obj-link" :class="p.cls" :href="p.href" draggable="false" :title="p.title" @click.prevent="root.onObjLinkClick($event, p.obj)">{{ p.text }}</a><span class="obj-tbl" :title="p.tblTitle" @mousedown.stop @click.stop="root.showObjInTable(p.obj)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/></svg></span></span><span v-else class="cell-line" :class="p.cls" :title="p.title">{{ p.text }}</span></template></span>
            <!-- Антивирусы (этап 26д): строкой каждый, цвет – по состоянию (Справочники) -->
            <span v-else-if="col.field === 'antivirus'" class="av-cell"><span v-for="(a, ai) in root.avItems(row)" :key="ai" class="av-line" :class="{ 'av-chip': !!(root.avCellStyle(a) || {}).backgroundColor }" :style="root.avCellStyle(a)" :title="root.avTitle(a)">{{ a.title }}</span></span>
            <!-- Значения по строкам: повтор – блочком, логина нет в Jabber – красным, номер GLPI / GSIT – ссылкой -->
            <!-- Принтеры у ПК, ПК у принтера (этап 44): ссылки; при наведении – значок «показать в таблице» -->
            <span v-else-if="col.links && root.cellParts(row, col)" class="cell-lines" :style="root.cellSpanStyle(row, col, editField === col.field)"><span v-for="(p, pi) in root.cellParts(row, col)" :key="pi" class="cell-line obj-line"><a class="obj-link" :href="p.href" draggable="false" :title="p.title" @click.prevent="root.onObjLinkClick($event, p.obj)">{{ p.text }}</a><span class="obj-tbl" :title="p.obj.kind === 'pc' ? 'Показать в Компьютерах' : 'Показать в Принтерах'" @mousedown.stop @click.stop="root.showObjInTable(p.obj)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/></svg></span></span></span>
            <!-- «Доступ» принтера, «Пароль» ПК (этапы 45, 70): заданные – точками; показанные по паролю – строками (у записи – учётная запись и пароль), ✎ – изменить, у ПК ＋ справа от пароля – ещё запись -->
            <span v-else-if="col.secret && root.webShownInCell(row) && editField !== col.field" class="secret-shown" :title="root.webAccessTitle(row)"><span class="cell-lines"><template v-for="(e, ei) in root.webShown.entries" :key="ei"><span class="cell-line" :class="{ 'cl-none': !e.login, 'cl-next': ei > 0 }">{{ e.login || root.webNoLogin(row) }}</span><span class="cell-line" :class="{ 'cl-none': !e.password }">{{ e.password || "без пароля" }}</span></template></span><span v-if="root.canEdit" class="secret-tools"><span class="secret-pen" title="Изменить" @mousedown.stop @dblclick.stop @click.stop="root.startWebEdit(row, 'cell')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg></span><span v-if="!row._printer" class="secret-pen" title="Ещё пароль" @mousedown.stop @dblclick.stop @click.stop="root.startWebEdit(row, 'cell', true)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span></span></span>
            <span v-else-if="col.secret && row.web_auth && editField !== col.field" class="secret-dots" title="Двойной клик – показать">{{ root.secretDots }}</span>
            <template v-else-if="col.secret"></template>
            <span v-else-if="root.cellParts(row, col)" class="cell-lines" :style="root.cellSpanStyle(row, col, editField === col.field)"><template v-for="(p, pi) in root.cellParts(row, col)" :key="pi"><a v-if="p.href" class="cell-line id-link" :class="p.cls" :href="p.href" target="_blank" rel="noopener" :title="p.title" @click="root.onIdLinkClick($event)">{{ p.text }}</a><a v-else-if="p.card" class="cell-line host-link" :class="p.cls" :style="p.style" :href="p.card" draggable="false" :title="p.title" @click.prevent>{{ p.text }}</a><span v-else class="cell-line" :class="p.cls" :style="p.style" :title="p.title" @dblclick="root.onCellValueDblclick($event, row, col)">{{ p.text }}</span></template></span>
            <span v-else :class="{ 'note-text': col.note, pending: root.isPending(row, col) }" :style="root.cellSpanStyle(row, col, editField === col.field)" @dblclick="root.onCellValueDblclick($event, row, col)">{{ root.cellText(row, col) }}</span>
            <button v-if="root.scanCellMark(row, col) && editField !== col.field" type="button" class="scan-chip"
                :class="{ open: root.scanPop && root.scanPop.row.id === row.id && root.scanPop.col.field === col.field }"
                :style="root.scanChipStyle(root.scanCellMark(row, col))" :title="root.scanChipTitle(root.scanCellDiff(row, col))"
                @mousedown.stop @dblclick.stop @click.stop="$event.altKey ? root.copyCellValue($event) : root.openScanPop(row, col, $event)">{{ root.scanChipText(root.scanCellDiff(row, col)) }}</button>
            <template v-if="editField === col.field">
                <!-- «Доступ» / «Пароль» (этапы 45, 70): учётная запись видна, пароль – точками; у ПК ＋ справа от заполненного пароля – ещё два поля; ячейка на время правки шире и выше -->
                <span v-if="col.secret && root.webEdit" class="secret-edit" :class="{ 'secret-many': !row._printer }" @focusout="root.onWebEditFocusOut($event)"><template v-for="(e, ei) in root.webEdit.entries" :key="ei"><input v-model="e.login" class="cell-edit secret-input" :class="{ 'se-next': ei > 0 }" :placeholder="root.webLoginLabel(row)" spellcheck="false" autocomplete="off" @keydown="root.onWebEditKeydown"><input v-model="e.password" class="cell-edit secret-input" type="password" placeholder="Пароль" autocomplete="new-password" @keydown="root.onWebEditKeydown"></template><span v-if="root.webEditCanAdd(row)" class="secret-pen secret-add" title="Ещё пароль" :style="{ gridRow: root.webEdit.entries.length * 2 }" @mousedown.prevent.stop @dblclick.stop @click.stop="root.addWebEntry()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span></span>
                <location-picker v-else-if="col.location" editor input-class="cell-edit" :value="row.location_id" :options="root.locationOptions"
                    :move-room="root.roomMove(row, col)" placeholder="Расположение…" @pick="root.onCellLocationPick(row, $event)"
                    @move-room="root.onRoomMove(row, $event)" @cancel="root.cancelEdit"></location-picker>
                <textarea v-else-if="col.multiline && !col.cartridges && !col.ipCol" v-model="root.editValue"
                    @keydown="root.handleEditKeydown($event, row, col)"
                    @input="col.field === 'ip' && root.onIpInput($event, null, 'editValue'); root.onEditInput($event, col)"
                    @blur="root.saveEdit(row, col)"
                    class="cell-edit cell-edit-multi"></textarea>
                <input v-else v-model="root.editValue"
                    @keydown="root.handleEditKeydown($event, row, col)"
                    @input="col.field === 'ip_addr' && root.onIpInput($event, null, 'editValue'); root.onEditInput($event, col); root.onSuggestInput($event.target.value)"
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
        editField: String,   // поле, которое правится в этой строке; null – никакое
        kit: String          // журнал: скобка комплекта у инвентарного – top / mid / bot
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
    // Строка, которую прячут поиск или фильтры, создаётся сразу спрятанной; дальше прячет и
    // показывает корень (syncHiddenRows, этап 65)
    mounted() {
        if (!this.root.isRowShown(this.row.id)) {
            this.$el.hidden = true;
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
            kit: this.kit,
            fills: this.fills,
            belowFills: this.belowFills
        }, cache);
    }
};
