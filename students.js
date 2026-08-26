/* ==========================================================================
   RESCUEPRIORITY — STUDENTS & SECTIONS MODULE
   --------------------------------------------------------------------------
   Additive module. Does NOT touch classrooms/, incidents/, or counters/.
   Reuses the existing Firebase connection, SCHOOL_FACILITIES list, and the
   isClassroomFacility() helper already exported from script.js instead of
   opening a second connection or duplicating the facility list.

   New Firebase paths owned by this file:
     students/{studentId}  -> lrn, firstName, middleName?, lastName,
                               extension?, parentMobileNo, parentEmail?,
                               sectionId, facilityId (denormalized)
     sections/{sectionId}  -> name, gradeId, gradeName, assignedTeacherId?,
                               facilityId  (must match a SCHOOL_FACILITIES id)

   Field names/shapes and the "QR encodes LRN only" approach are carried
   over from the astig frontend (features/student/types/student.ts +
   StudentQrModal.tsx) as a reference — no astig code or backend is used.

   QR generation uses the `qrcode` UMD build loaded via <script> in
   index.html (exposes window.QRCode), the same API astig's
   StudentQrModal.tsx calls: QRCode.toCanvas(canvas, text, options).
========================================================================== */

import { database, SCHOOL_FACILITIES, isClassroomFacility } from "./script.js";
import {
    ref,
    push,
    set,
    update,
    remove,
    onValue,
    query,
    orderByChild,
    startAt
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const studentsRootRef = ref(database, "students");
const sectionsRootRef = ref(database, "sections");

/* Read-only ref onto the attendance/ tree already owned by
   scan-attendance.js. Just a pointer — no listener is attached until the
   Section Detail modal (below) is actually open, so this doesn't touch or
   duplicate scan-attendance.js's own always-on setupLiveStats() listener. */
const attendanceRootRef = ref(database, "attendance");

/* Live in-memory caches, keyed by push id. Populated by onValue listeners
   set up once in initStudentsModule(). Exported so scan-attendance.js can
   reuse the same live student list instead of opening its own listener. */
export let studentsState = {};   // studentId -> student record
export let sectionsState = {};   // sectionId -> section record

const classroomFacilities = SCHOOL_FACILITIES.filter(isClassroomFacility);

/* ==========================================================================
   VALIDATION (mirrors astig's studentSchema.ts rules, re-implemented in
   plain JS since this project has no build step / no zod dependency)
========================================================================== */
function validateStudentForm(values) {
    const errors = {};

    if (!values.lrn || !values.lrn.trim()) errors.lrn = "LRN is required.";
    if (!values.firstName || !values.firstName.trim()) errors.firstName = "First name is required.";
    if (!values.lastName || !values.lastName.trim()) errors.lastName = "Last name is required.";
    if (!values.parentMobileNo || !values.parentMobileNo.trim()) errors.parentMobileNo = "Parent mobile number is required.";
    if (!values.sectionId) errors.sectionId = "Please select a section.";

    return errors;
}

function validateSectionForm(values) {
    const errors = {};

    if (!values.name || !values.name.trim()) errors.name = "Section name is required.";
    if (!values.gradeName || !values.gradeName.trim()) errors.gradeName = "Grade level is required.";
    if (!values.facilityId) errors.facilityId = "Please link a facility/room.";

    return errors;
}

function slugify(text) {
    return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/* ==========================================================================
   INITIALIZATION
   Self-initializes on load (same pattern as insights.js / weather.js) so
   the students/sections listeners are always live — scan-attendance.js
   imports studentsState as a live binding and depends on this having run.
========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
    initStudentsModule();
});

export function initStudentsModule() {
    setupSubtabs();
    setupStudentsToolbar();
    setupSectionsToolbar();
    setupStudentModal();
    setupSectionModal();
    setupSectionDetailModal();
    setupQrModal();

    onValue(sectionsRootRef, (snapshot) => {
        sectionsState = snapshot.val() || {};
        renderSectionsTable();
        populateSectionDropdown();
    });

    onValue(studentsRootRef, (snapshot) => {
        studentsState = snapshot.val() || {};
        renderStudentsTable();
    });
}

/* ==========================================================================
   SUB-TABS (Students <-> Sections)
========================================================================== */
function setupSubtabs() {
    document.querySelectorAll(".students-subtab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".students-subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));

            const target = btn.dataset.subtab;
            document.querySelectorAll(".students-subpanel").forEach((panel) => {
                panel.classList.toggle("hidden", panel.dataset.subpanel !== target);
            });
        });
    });
}

/* ==========================================================================
   STUDENTS TABLE
========================================================================== */
let studentSearchTerm = "";

function setupStudentsToolbar() {
    const searchInput = document.getElementById("students-search-input");
    const addButton = document.getElementById("btn-add-student");

    if (searchInput) {
        searchInput.addEventListener("input", () => {
            studentSearchTerm = searchInput.value.trim().toLowerCase();
            renderStudentsTable();
        });
    }

    if (addButton) {
        addButton.addEventListener("click", () => openStudentModal(null));
    }
}

function studentFullName(student) {
    return [student.firstName, student.middleName, student.lastName, student.extension]
        .filter((v) => v && String(v).trim())
        .join(" ");
}

function renderStudentsTable() {
    const tbody = document.getElementById("students-table-body");
    const emptyState = document.getElementById("students-table-empty");

    if (!tbody) return;

    const rows = Object.entries(studentsState)
        .map(([id, student]) => ({ id, ...student }))
        .filter((student) => {
            if (!studentSearchTerm) return true;
            const haystack = `${studentFullName(student)} ${student.lrn}`.toLowerCase();
            return haystack.includes(studentSearchTerm);
        })
        .sort((a, b) => studentFullName(a).localeCompare(studentFullName(b)));

    tbody.innerHTML = "";

    if (rows.length === 0) {
        if (emptyState) emptyState.classList.remove("hidden");
        return;
    }
    if (emptyState) emptyState.classList.add("hidden");

    rows.forEach((student) => {
        const section = sectionsState[student.sectionId];
        const tr = document.createElement("tr");

        tr.innerHTML = `
            <td>${escapeHtml(studentFullName(student))}</td>
            <td><span class="pill-tag">${escapeHtml(student.lrn || "--")}</span></td>
            <td>${escapeHtml(section ? section.name : "Unassigned")}</td>
            <td>${escapeHtml(section ? section.gradeName : "--")}</td>
            <td>${escapeHtml(student.parentMobileNo || "--")}</td>
            <td>
                <div class="table-row-actions">
                    <button type="button" class="icon-btn btn-view-qr" data-id="${student.id}">QR</button>
                    <button type="button" class="icon-btn btn-edit-student" data-id="${student.id}">Edit</button>
                    <button type="button" class="icon-btn icon-btn-danger btn-delete-student" data-id="${student.id}">Delete</button>
                </div>
            </td>
        `;

        tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".btn-view-qr").forEach((btn) => {
        btn.addEventListener("click", () => openQrModal(btn.dataset.id));
    });
    tbody.querySelectorAll(".btn-edit-student").forEach((btn) => {
        btn.addEventListener("click", () => openStudentModal(btn.dataset.id));
    });
    tbody.querySelectorAll(".btn-delete-student").forEach((btn) => {
        btn.addEventListener("click", () => deleteStudent(btn.dataset.id));
    });
}

async function deleteStudent(studentId) {
    const student = studentsState[studentId];
    if (!student) return;

    const confirmed = window.confirm(`Remove ${studentFullName(student)} (LRN ${student.lrn}) from the student list?`);
    if (!confirmed) return;

    await remove(ref(database, `students/${studentId}`));
}

/* ==========================================================================
   STUDENT ADD / EDIT MODAL
========================================================================== */
let editingStudentId = null;

function setupStudentModal() {
    const modal = document.getElementById("student-modal");
    const closeBtn = document.getElementById("student-modal-close");
    const cancelBtn = document.getElementById("btn-student-cancel");
    const saveBtn = document.getElementById("btn-student-save");

    if (closeBtn) closeBtn.addEventListener("click", closeStudentModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeStudentModal);
    if (modal) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) closeStudentModal();
        });
    }
    if (saveBtn) saveBtn.addEventListener("click", handleStudentSave);
}

function populateSectionDropdown() {
    const select = document.getElementById("student-field-sectionId");
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = '<option value="">Select a section...</option>';

    Object.entries(sectionsState)
        .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""))
        .forEach(([id, section]) => {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = `${section.name} (${section.gradeName})`;
            select.appendChild(opt);
        });

    if (currentValue) select.value = currentValue;
}

function openStudentModal(studentId) {
    editingStudentId = studentId;
    const modal = document.getElementById("student-modal");
    const title = document.getElementById("student-modal-title");
    const student = studentId ? studentsState[studentId] : null;

    clearStudentFormErrors();

    document.getElementById("student-field-lrn").value = student?.lrn || "";
    document.getElementById("student-field-firstName").value = student?.firstName || "";
    document.getElementById("student-field-middleName").value = student?.middleName || "";
    document.getElementById("student-field-lastName").value = student?.lastName || "";
    document.getElementById("student-field-extension").value = student?.extension || "";
    document.getElementById("student-field-parentMobileNo").value = student?.parentMobileNo || "";
    document.getElementById("student-field-parentEmail").value = student?.parentEmail || "";
    document.getElementById("student-field-sectionId").value = student?.sectionId || "";

    if (title) title.textContent = student ? "Edit Student" : "Add Student";
    if (modal) modal.classList.remove("hidden");
}

function closeStudentModal() {
    const modal = document.getElementById("student-modal");
    if (modal) modal.classList.add("hidden");
    editingStudentId = null;
}

function clearStudentFormErrors() {
    document.querySelectorAll("#student-modal .field-error").forEach((el) => (el.textContent = ""));
    const generalError = document.getElementById("student-form-general-error");
    if (generalError) generalError.classList.add("hidden");
}

async function handleStudentSave() {
    const values = {
        lrn: document.getElementById("student-field-lrn").value.trim(),
        firstName: document.getElementById("student-field-firstName").value.trim(),
        middleName: document.getElementById("student-field-middleName").value.trim(),
        lastName: document.getElementById("student-field-lastName").value.trim(),
        extension: document.getElementById("student-field-extension").value.trim(),
        parentMobileNo: document.getElementById("student-field-parentMobileNo").value.trim(),
        parentEmail: document.getElementById("student-field-parentEmail").value.trim(),
        sectionId: document.getElementById("student-field-sectionId").value
    };

    clearStudentFormErrors();
    const errors = validateStudentForm(values);

    if (Object.keys(errors).length > 0) {
        Object.entries(errors).forEach(([field, message]) => {
            const el = document.getElementById(`student-error-${field}`);
            if (el) el.textContent = message;
        });
        return;
    }

    // Duplicate-LRN guard (LRN is the QR payload and the scan-time lookup
    // key, so it must be unique across students).
    const duplicate = Object.entries(studentsState).find(
        ([id, s]) => s.lrn === values.lrn && id !== editingStudentId
    );
    if (duplicate) {
        const generalError = document.getElementById("student-form-general-error");
        if (generalError) {
            generalError.textContent = "That LRN is already registered to another student.";
            generalError.classList.remove("hidden");
        }
        return;
    }

    const section = sectionsState[values.sectionId];
    const payload = {
        lrn: values.lrn,
        firstName: values.firstName,
        middleName: values.middleName || null,
        lastName: values.lastName,
        extension: values.extension || null,
        parentMobileNo: values.parentMobileNo,
        parentEmail: values.parentEmail || null,
        sectionId: values.sectionId,
        facilityId: section ? section.facilityId : null   // denormalized for fast scan-time lookup
    };

    if (editingStudentId) {
        await update(ref(database, `students/${editingStudentId}`), payload);
    } else {
        await set(push(studentsRootRef), payload);
    }

    closeStudentModal();
}

/* ==========================================================================
   SECTIONS TABLE
========================================================================== */
function setupSectionsToolbar() {
    const addButton = document.getElementById("btn-add-section");
    if (addButton) addButton.addEventListener("click", () => openSectionModal(null));
}

function renderSectionsTable() {
    const tbody = document.getElementById("sections-table-body");
    const emptyState = document.getElementById("sections-table-empty");

    if (!tbody) return;

    const rows = Object.entries(sectionsState).sort((a, b) =>
        (a[1].name || "").localeCompare(b[1].name || "")
    );

    tbody.innerHTML = "";

    if (rows.length === 0) {
        if (emptyState) emptyState.classList.remove("hidden");
        return;
    }
    if (emptyState) emptyState.classList.add("hidden");

    rows.forEach(([id, section]) => {
        const facility = SCHOOL_FACILITIES.find((f) => f.id === section.facilityId);
        const studentCount = Object.values(studentsState).filter((s) => s.sectionId === id).length;

        const tr = document.createElement("tr");
        // Row is clickable (opens the Section Detail view) in addition to
        // the explicit "View" button, so either affordance works. Edit/
        // Delete stay as their own buttons and stop the row click via the
        // event.target.closest("button") guard below.
        tr.className = "row-clickable";
        tr.dataset.id = id;
        tr.innerHTML = `
            <td>${escapeHtml(section.name)}</td>
            <td>${escapeHtml(section.gradeName)}</td>
            <td>${escapeHtml(section.assignedTeacherId || "--")}</td>
            <td>${escapeHtml(facility ? facility.name : "Not linked")}</td>
            <td>${studentCount}</td>
            <td>
                <div class="table-row-actions">
                    <button type="button" class="icon-btn btn-view-section" data-id="${id}">View</button>
                    <button type="button" class="icon-btn btn-edit-section" data-id="${id}">Edit</button>
                    <button type="button" class="icon-btn icon-btn-danger btn-delete-section" data-id="${id}">Delete</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".row-clickable").forEach((tr) => {
        tr.addEventListener("click", (event) => {
            if (event.target.closest("button")) return; // let Edit/Delete handle their own clicks
            openSectionDetailModal(tr.dataset.id);
        });
    });
    tbody.querySelectorAll(".btn-view-section").forEach((btn) => {
        btn.addEventListener("click", () => openSectionDetailModal(btn.dataset.id));
    });
    tbody.querySelectorAll(".btn-edit-section").forEach((btn) => {
        btn.addEventListener("click", () => openSectionModal(btn.dataset.id));
    });
    tbody.querySelectorAll(".btn-delete-section").forEach((btn) => {
        btn.addEventListener("click", () => deleteSection(btn.dataset.id));
    });
}

async function deleteSection(sectionId) {
    const section = sectionsState[sectionId];
    if (!section) return;

    const studentCount = Object.values(studentsState).filter((s) => s.sectionId === sectionId).length;
    if (studentCount > 0) {
        window.alert(`Can't delete "${section.name}" — ${studentCount} student(s) are still assigned to it. Reassign them first.`);
        return;
    }

    const confirmed = window.confirm(`Delete section "${section.name}"?`);
    if (!confirmed) return;

    await remove(ref(database, `sections/${sectionId}`));
}

/* ==========================================================================
   SECTION ADD / EDIT MODAL
========================================================================== */
let editingSectionId = null;

function setupSectionModal() {
    const modal = document.getElementById("section-modal");
    const closeBtn = document.getElementById("section-modal-close");
    const cancelBtn = document.getElementById("btn-section-cancel");
    const saveBtn = document.getElementById("btn-section-save");

    if (closeBtn) closeBtn.addEventListener("click", closeSectionModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeSectionModal);
    if (modal) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) closeSectionModal();
        });
    }
    if (saveBtn) saveBtn.addEventListener("click", handleSectionSave);

    populateFacilityDropdown();
}

function populateFacilityDropdown() {
    const select = document.getElementById("section-field-facilityId");
    if (!select) return;

    select.innerHTML = '<option value="">Select a room on the campus map...</option>';

    classroomFacilities.forEach((facility) => {
        const opt = document.createElement("option");
        opt.value = facility.id;
        opt.textContent = `${facility.name} — ${facility.section} (${facility.zone})`;
        select.appendChild(opt);
    });
}

function openSectionModal(sectionId) {
    editingSectionId = sectionId;
    const modal = document.getElementById("section-modal");
    const title = document.getElementById("section-modal-title");
    const section = sectionId ? sectionsState[sectionId] : null;

    clearSectionFormErrors();

    document.getElementById("section-field-name").value = section?.name || "";
    document.getElementById("section-field-gradeName").value = section?.gradeName || "";
    document.getElementById("section-field-assignedTeacherId").value = section?.assignedTeacherId || "";
    document.getElementById("section-field-facilityId").value = section?.facilityId || "";

    if (title) title.textContent = section ? "Edit Section" : "Add Section";
    if (modal) modal.classList.remove("hidden");
}

function closeSectionModal() {
    const modal = document.getElementById("section-modal");
    if (modal) modal.classList.add("hidden");
    editingSectionId = null;
}

function clearSectionFormErrors() {
    document.querySelectorAll("#section-modal .field-error").forEach((el) => (el.textContent = ""));
}

async function handleSectionSave() {
    const values = {
        name: document.getElementById("section-field-name").value.trim(),
        gradeName: document.getElementById("section-field-gradeName").value.trim(),
        assignedTeacherId: document.getElementById("section-field-assignedTeacherId").value.trim(),
        facilityId: document.getElementById("section-field-facilityId").value
    };

    clearSectionFormErrors();
    const errors = validateSectionForm(values);

    if (Object.keys(errors).length > 0) {
        Object.entries(errors).forEach(([field, message]) => {
            const el = document.getElementById(`section-error-${field}`);
            if (el) el.textContent = message;
        });
        return;
    }

    const payload = {
        name: values.name,
        gradeName: values.gradeName,
        gradeId: slugify(values.gradeName),
        assignedTeacherId: values.assignedTeacherId || null,
        facilityId: values.facilityId
    };

    if (editingSectionId) {
        await update(ref(database, `sections/${editingSectionId}`), payload);

        // Keep denormalized facilityId in sync on every student in this
        // section, so scan-time lookups never point at a stale room.
        const affected = Object.entries(studentsState).filter(([, s]) => s.sectionId === editingSectionId);
        await Promise.all(
            affected.map(([id]) => update(ref(database, `students/${id}`), { facilityId: values.facilityId }))
        );
    } else {
        await set(push(sectionsRootRef), payload);
    }

    closeSectionModal();
}

/* ==========================================================================
   SECTION DETAIL VIEW (read-only roster + live presence dots)
   --------------------------------------------------------------------------
   New, additive feature. Clicking a Sections row (or its "View" button)
   opens a modal listing every student in that section, each with a green/
   red dot for "currently checked in".

   Presence is derived from today's attendance/{logId} logs using the exact
   same rule scan-attendance.js's setupLiveStats() uses for its header
   counters: query today's logs only, keep the latest log per studentId,
   and treat direction === "in" as present. That logic lives in a private,
   unexported function inside scan-attendance.js, so it's re-implemented
   here rather than duplicated via import — this block is the "duplicate
   the same query/reduce pattern consistently" option called out in the
   spec, kept intentionally close to the original so the two stay in sync
   if either is changed.

   The attendance listener here is scoped to this modal only: it's attached
   with onValue() when the modal opens and detached when it closes, so it
   never competes with or duplicates the always-on students/sections
   listeners set up once in initStudentsModule(), or scan-attendance.js's
   own always-on listener.
========================================================================== */
let sectionDetailId = null;
let sectionDetailUnsubscribe = null;

function setupSectionDetailModal() {
    const modal = document.getElementById("section-detail-modal");
    const closeBtn = document.getElementById("section-detail-modal-close");

    if (closeBtn) closeBtn.addEventListener("click", closeSectionDetailModal);
    if (modal) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) closeSectionDetailModal();
        });
    }
}

function openSectionDetailModal(sectionId) {
    const section = sectionsState[sectionId];
    if (!section) return;

    sectionDetailId = sectionId;

    const modal = document.getElementById("section-detail-modal");
    const title = document.getElementById("section-detail-title");
    const subtitle = document.getElementById("section-detail-subtitle");
    const facility = SCHOOL_FACILITIES.find((f) => f.id === section.facilityId);

    if (title) title.textContent = section.name;
    if (subtitle) {
        subtitle.textContent = `${section.gradeName || "--"} \u00b7 ${facility ? facility.name : "Not linked"}`;
    }

    // Draw names immediately so the list isn't empty while the presence
    // query resolves; dots fill in (and then stay live) once it does.
    renderSectionDetailList({});
    if (modal) modal.classList.remove("hidden");

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayQuery = query(attendanceRootRef, orderByChild("timestamp"), startAt(startOfToday.getTime()));

    sectionDetailUnsubscribe = onValue(todayQuery, (snapshot) => {
        const logs = snapshot.val() || {};

        // Latest log per studentId today -> direction "in" means present.
        // Mirrors scan-attendance.js's setupLiveStats() reduction exactly.
        const latestByStudent = {};
        Object.values(logs).forEach((log) => {
            const existing = latestByStudent[log.studentId];
            if (!existing || log.timestamp > existing.timestamp) {
                latestByStudent[log.studentId] = log;
            }
        });

        const presentMap = {};
        Object.entries(latestByStudent).forEach(([studentId, log]) => {
            presentMap[studentId] = log.direction === "in";
        });

        renderSectionDetailList(presentMap);
    });
}

function closeSectionDetailModal() {
    const modal = document.getElementById("section-detail-modal");
    if (modal) modal.classList.add("hidden");

    if (sectionDetailUnsubscribe) {
        sectionDetailUnsubscribe(); // detach the presence listener — modal is closed, no need to keep it live
        sectionDetailUnsubscribe = null;
    }
    sectionDetailId = null;
}

function renderSectionDetailList(presentMap) {
    const list = document.getElementById("section-detail-list");
    const emptyState = document.getElementById("section-detail-empty");
    if (!list || !sectionDetailId) return;

    const rows = Object.entries(studentsState)
        .filter(([, student]) => student.sectionId === sectionDetailId)
        .map(([id, student]) => ({ id, ...student }))
        .sort((a, b) => studentFullName(a).localeCompare(studentFullName(b)));

    list.innerHTML = "";

    if (rows.length === 0) {
        if (emptyState) emptyState.classList.remove("hidden");
        return;
    }
    if (emptyState) emptyState.classList.add("hidden");

    rows.forEach((student) => {
        const isPresent = !!presentMap[student.id];
        const li = document.createElement("li");
        li.className = "section-detail-student";
        li.innerHTML = `
            <span class="status-dot ${isPresent ? "status-dot-present" : "status-dot-absent"}" title="${isPresent ? "Checked in" : "Not checked in"}"></span>
            <span class="section-detail-student-name">${escapeHtml(studentFullName(student))}</span>
        `;
        list.appendChild(li);
    });
}

/* ==========================================================================
   QR MODAL (LRN-only payload, matches astig's StudentQrModal.tsx approach —
   ported to plain JS + the qrcode UMD build instead of npm/React)
========================================================================== */
function setupQrModal() {
    const modal = document.getElementById("student-qr-modal");
    const closeBtn = document.getElementById("qr-modal-close");
    const downloadBtn = document.getElementById("btn-qr-download");

    if (closeBtn) closeBtn.addEventListener("click", closeQrModal);
    if (modal) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) closeQrModal();
        });
    }
    if (downloadBtn) downloadBtn.addEventListener("click", downloadCurrentQr);
}

let currentQrDataUrl = null;
let currentQrStudent = null;

async function openQrModal(studentId) {
    const student = studentsState[studentId];
    if (!student) return;

    currentQrStudent = student;
    currentQrDataUrl = null;

    document.getElementById("qr-modal-student-name").textContent = studentFullName(student);
    document.getElementById("qr-modal-student-lrn").textContent = `LRN: ${student.lrn}`;

    const frame = document.getElementById("qr-canvas-frame");
    frame.innerHTML = '<p class="qr-status-text">Generating QR code...</p>';

    document.getElementById("student-qr-modal").classList.remove("hidden");

    if (typeof window.QRCode === "undefined") {
        frame.innerHTML = '<p class="qr-status-text">QR library failed to load.</p>';
        return;
    }

    try {
        const canvas = document.createElement("canvas");
        await window.QRCode.toCanvas(canvas, student.lrn, {
            width: 500,
            margin: 2,
            errorCorrectionLevel: "H"
        });

        // qrcode's toCanvas() sets its own inline width/height style on the
        // canvas (to keep it crisp at the pixel size it just drew), which
        // beats the .qr-canvas-frame canvas rule in students.css since
        // inline styles win over stylesheets. Clear that inline sizing so
        // the stylesheet's 240x240 display size (the actual 500x500 canvas
        // stays intentionally full-res for the downloaded file) takes over.
        canvas.style.width = "";
        canvas.style.height = "";

        frame.innerHTML = "";
        frame.appendChild(canvas);
        currentQrDataUrl = canvas.toDataURL("image/jpeg", 0.95);
    } catch (error) {
        console.error("Failed to generate student QR code:", error);
        frame.innerHTML = '<p class="qr-status-text">Unable to generate the QR code.</p>';
    }
}

function closeQrModal() {
    document.getElementById("student-qr-modal").classList.add("hidden");
    currentQrDataUrl = null;
    currentQrStudent = null;
}

function downloadCurrentQr() {
    if (!currentQrDataUrl || !currentQrStudent) return;

    const namePart = [currentQrStudent.firstName, currentQrStudent.middleName, currentQrStudent.lastName, currentQrStudent.extension]
        .filter((v) => v && String(v).trim())
        .map((v) => String(v).trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, ""))
        .join("-");

    const link = document.createElement("a");
    link.href = currentQrDataUrl;
    link.download = `${namePart || currentQrStudent.lrn}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/* ==========================================================================
   UTIL
========================================================================== */
function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
