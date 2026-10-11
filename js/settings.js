function getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') {
            c = c.substring(1, c.length);
        }
        if (c.indexOf(nameEQ) === 0) {
            return decodeURIComponent(c.substring(nameEQ.length, c.length));
        }
    }
    return null;
}

if (getCookie("title") === null) {
    document.cookie = "title=Taco Proxy" + ";path=/";
    document.cookie = "icon=images/favicon.ico" + ";path=/";
}

document.getElementById("settingsBackArrow").onclick = function() {
    document.cookie = "title=" + encodeURIComponent(getCookie("title")) + ";path=/";
    document.cookie = "icon=" + encodeURIComponent(getCookie("icon")) + ";path=/";
    // go back to whatever this tab was showing before Settings
    if (window.tacoToolbar && window.tacoToolbar.canGoBack()) {
        window.tacoToolbar.back();
    } else {
        window.location.href = "/";
    }
}
document.getElementById("resetTabCloakBtn").onclick = function() {
    document.cookie = "title=Taco Proxy" + ";path=/";
    document.cookie = "icon=images/favicon.ico" + ";path=/";
}

document.title = getCookie("title");
document.getElementById("favicon").setAttribute("href", getCookie("icon"));

function switchTabCloak(selectedValue) {
    if (selectedValue === "default") {
        console.log("Default selected");
        document.cookie = "title=Taco Proxy" + ";path=/";
        document.cookie = "icon=images/favicon.ico" + ";path=/";
    } else if (selectedValue === "google") {
        console.log("Google selected");
        document.cookie = "title=Google" + ";path=/";
        document.cookie = "icon=images/google_icon.png" + ";path=/";
    } else if (selectedValue === "classroom") {
        console.log("Classroom selected");
        document.cookie = "title=Home" + ";path=/";
        document.cookie = "icon=images/classroom_icon.png" + ";path=/";
    } else if (selectedValue === "classlink") {
        console.log("Classlink selected");
        document.cookie = "title=Classlink" + ";path=/";
        document.cookie = "icon=images/classlink_icon.png" + ";path=/";
    } else if (selectedValue === "ixl") {
        console.log("IXL selected");
        document.cookie = "title=IXL" + ";path=/";
        document.cookie = "icon=images/ixl_icon.png" + ";path=/";
    } else if (selectedValue === "gmail") {
        console.log("Gmail selected");
        document.cookie = "title=Gmail" + ";path=/";
        document.cookie = "icon=images/gmail_icon.png" + ";path=/";
    } else if (selectedValue === "brainpop") {
        console.log("BrainPOP selected");
        document.cookie = "title=BrainPOP" + ";path=/";
        document.cookie = "icon=images/brainpop_icon.png" + ";path=/";
    }
}

document.getElementById("tabCloakSelect").addEventListener("change", function() {
    switchTabCloak(this.value);
    document.title = getCookie("title");
    document.getElementById("favicon").setAttribute("href", getCookie("icon"));
});