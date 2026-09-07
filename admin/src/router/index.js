import { createRouter, createWebHashHistory } from "vue-router";

const router = createRouter({
  // 用 hash 模式，方便静态托管直接部署无需服务端配置
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/list" },
    {
      path: "/login",
      name: "login",
      component: () => import("../views/Login.vue"),
      meta: { public: true },
    },
    {
      path: "/list",
      name: "list",
      component: () => import("../views/PostList.vue"),
    },
    {
      path: "/post/:id",
      name: "detail",
      component: () => import("../views/PostDetail.vue"),
    },
    {
      path: "/post/:id/edit",
      name: "edit",
      component: () => import("../views/PostEdit.vue"),
    },
    {
      path: "/create",
      name: "create",
      component: () => import("../views/PostCreate.vue"),
    },
    {
      path: "/tops",
      name: "tops",
      component: () => import("../views/TopManage.vue"),
    },
    {
      path: "/notice",
      name: "notice",
      component: () => import("../views/NoticeManage.vue"),
    },
    {
      path: "/users",
      name: "users",
      component: () => import("../views/UserList.vue"),
    },
    {
      path: "/stats",
      name: "stats",
      component: () => import("../views/Dashboard.vue"),
    },
    {
      path: "/logs",
      name: "logs",
      component: () => import("../views/Logs.vue"),
    },
  ],
});

// 路由守卫：未登录跳转登录页
router.beforeEach((to) => {
  const authed = localStorage.getItem("baozi_admin_authed") === "true";
  if (!to.meta.public && !authed) {
    return { name: "login" };
  }
  if (to.name === "login" && authed) {
    return { name: "list" };
  }
  return true;
});

export default router;
